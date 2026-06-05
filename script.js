// ============================================================
// Hourglass — Light blobs (monochrome)
// 상태: IDLE_EMPTY  →  (orb 클릭)  →  FILLING  →  (1분 후) →  IDLE_FULL  →  (클릭)  →  ...
//
// 디자인 원칙 (motion-reference.md):
//  - 모노크롬: #000 배경, #FFFFFF 빛
//  - additive blending (globalCompositeOperation = 'lighter')이 핵심
//  - 입자 anatomy: core + inner glow + outer halo (사전 렌더 sprite)
//  - 사이즈 분포: 70% dust, 22% medium, 6% large, 2% hero
//  - 4단계 모션: A scattered / B convergence / C singularity / D dispersion
//  - "1분"은 코드 상수로만, 화면 표시 금지
// ============================================================

const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const hint = document.getElementById("hint");

// ---------- 상수 ----------
const TOTAL_FILL_MS = 60_000;
const PARTICLE_COUNT = 130;
const ORB_BASE_R = 18;
const ORB_MAX_R = 78;
const TRAIL_FADE = 0.34; // 매 프레임 검정 알파로 덮어 잔상 (모션 블러 효과)

// ---------- 상태 ----------
const State = {
  IDLE_EMPTY: "idle_empty",
  FILLING: "filling",
  IDLE_FULL: "idle_full",
  DISPERSING: "dispersing",
  ERROR: "error",       // 가장자리에 강하게 부딪힌 직후 — 입자 폭발 + 오브 진동
};
let state = State.IDLE_EMPTY;

// ---------- 캔버스 / 뷰포트 ----------
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  orb.baseCx = W * 0.5;
  orb.baseCy = H * 0.5;
}

// ============================================================
// 베지에 이징
// cubic-bezier(x1,y1,x2,y2) → progress(0~1)를 이징된 값으로
// ============================================================
function makeBezierEase(x1, y1, x2, y2) {
  // binary search로 t를 찾고 → y 계산
  return function (p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let lo = 0, hi = 1, t = p;
    for (let i = 0; i < 16; i++) {
      t = (lo + hi) / 2;
      const it = 1 - t;
      const x = 3 * it * it * t * x1 + 3 * it * t * t * x2 + t * t * t;
      if (x < p) lo = t;
      else hi = t;
    }
    t = (lo + hi) / 2;
    const it = 1 - t;
    return 3 * it * it * t * y1 + 3 * it * t * t * y2 + t * t * t;
  };
}

const easeConv = makeBezierEase(0.55, 0, 0.85, 0.2); // Phase B: ease-in 강함
const easeDisp = makeBezierEase(0.15, 0.8, 0.4, 1);  // Phase D: ease-out 강함 (촤악 터지고 부드럽게 안착)

// ---------- 방해(disturb) — 드래그/흔들기 ----------
const POINTER_HISTORY_MS = 120;     // 최근 N ms 동안의 포인터 궤적으로 shake 강도 계산
const SHAKE_INPUT_GAIN = 6;          // 누적 시 속도(px/ms)에 곱하는 게인
const SHAKE_DECAY = 0.88;            // 누적치의 프레임당 감쇠율
const SHAKE_EJECT_THRESHOLD = 50;    // 누적치가 이 값 넘으면 입자 1개 사출
const SHAKE_COOLDOWN_MS = 16;        // 사출 간 최소 간격 (~매 프레임 1개까지)
const SHAKE_EJECT_DRAIN = 0.4;       // 사출 시 누적치에서 빠지는 비율 (낮을수록 연속 사출 잘 됨)
const SPRING_DECAY = 0.88;           // 손 뗀 뒤 오브의 위치 스프링 감쇠율

const pointerHistory = [];           // {x, y, t} 최근 포인터 이력
let shakeAccumulator = 0;
let lastEjectAt = 0;

// ---------- 커서 척력 — FILLING 중 입자가 마우스를 피하게 ----------
const cursor = { x: 0, y: 0, active: false }; // active: 캔버스 위에 있을 때만 true
const CURSOR_REPULSE_R = 180;            // 척력 영향 반경
const CURSOR_REPULSE_R_SQ = CURSOR_REPULSE_R * CURSOR_REPULSE_R;
const CURSOR_REPULSE_GAIN = 6;           // 반경 중심에서 한 프레임당 최대 추력(px)
const CURSOR_REPULSE_DECAY = 0.86;       // 커서가 멀어지면 입자가 본 자리로 lerp 복귀

// ---------- 에러(임팩트) — 가장자리 충돌 ----------
const IMPACT_SPEED_THRESHOLD = 1.1;  // px/ms — 이 속도 이상으로 가장자리를 향하면 임팩트
const IMPACT_EDGE_MARGIN = 56;       // 화면 가장자리에서 이 픽셀 안쪽이면 "끝에 닿음"
const ERROR_HOLD_MS = 1000;          // mouse up 후 이 시간만큼 진동 유지 → IDLE_EMPTY로 복귀
const ERROR_BURST_SPREAD = Math.PI * 0.7; // 반대 방향 ±63° 콘으로 방사형 분산

// ---------- 오브 색상 — fill 진행도에 따른 4-스톱 그라디언트 ----------
//  0%   #78D9FF (대기, 차가운 파랑)
//  33%  #78E87E (초록)
//  67%  #FFF07C (노랑)
// 100%  #FF5F5F (가득, 뜨거운 빨강)
const ORB_COLOR_STOPS = [
  { p: 0.00, r: 0x78, g: 0xD9, b: 0xFF },
  { p: 0.33, r: 0x78, g: 0xE8, b: 0x7E },
  { p: 0.67, r: 0xFF, g: 0xF0, b: 0x7C },
  { p: 1.00, r: 0xFF, g: 0x5F, b: 0x5F },
];

// ============================================================
// 입자 sprite (사전 렌더) — core + inner glow + outer halo
// 한 번 그려두고 drawImage로 스케일해 찍어 성능 확보
// ============================================================
const SPRITE_RADIUS = 64;
const SPRITE_SIZE = SPRITE_RADIUS * 2;
const SPRITE_CORE_FRAC = 0.12; // 스프라이트 내 코어가 차지하는 비율 (반경 기준)
const particleSprite = document.createElement("canvas");
particleSprite.width = SPRITE_SIZE;
particleSprite.height = SPRITE_SIZE;
(function buildParticleSprite() {
  const s = particleSprite.getContext("2d");
  const c = SPRITE_RADIUS;
  // 1) Outer halo (저알파, 큰 반경)
  let g = s.createRadialGradient(c, c, 0, c, c, SPRITE_RADIUS);
  g.addColorStop(0.0, "rgba(255,255,255,0.16)");
  g.addColorStop(0.25, "rgba(255,255,255,0.07)");
  g.addColorStop(0.6, "rgba(255,255,255,0.02)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  s.fillStyle = g;
  s.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  // 2) Inner glow
  g = s.createRadialGradient(c, c, 0, c, c, SPRITE_RADIUS * 0.4);
  g.addColorStop(0.0, "rgba(255,255,255,0.55)");
  g.addColorStop(0.55, "rgba(255,255,255,0.18)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  s.fillStyle = g;
  s.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  // 3) Core (선명한 흰 점)
  g = s.createRadialGradient(c, c, 0, c, c, SPRITE_RADIUS * SPRITE_CORE_FRAC);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.55, "rgba(255,255,255,0.92)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  s.fillStyle = g;
  s.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
})();

// ============================================================
// 입자
// ============================================================
function weightedPick(values, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < values.length; i++) {
    r -= weights[i];
    if (r <= 0) return values[i];
  }
  return values[values.length - 1];
}

class Particle {
  constructor() {
    // 사이즈 프로파일 — motion-reference의 분포 비율 (70/22/6/2)
    const profile = weightedPick(
      ["dust", "medium", "large", "hero"],
      [0.70, 0.22, 0.06, 0.02]
    );
    if (profile === "dust") {
      this.coreR = 1.2 + Math.random() * 1.4;
      this.brightness = 0.55 + Math.random() * 0.3;
      this.extraGlow = 0;
    } else if (profile === "medium") {
      this.coreR = 3.5 + Math.random() * 2.5;
      this.brightness = 0.85 + Math.random() * 0.15;
      this.extraGlow = 0;
    } else if (profile === "large") {
      this.coreR = 7 + Math.random() * 4;
      this.brightness = 0.95;
      this.extraGlow = 0.6;
    } else {
      // hero
      this.coreR = 13 + Math.random() * 6;
      this.brightness = 1.0;
      this.extraGlow = 1.0;
    }

    this.scatter();

    // Phase A 모션 — 두 주파수 합성:
    //  orbit: 느린 주기(7~20s)의 큰 진폭 → 입자가 천천히 원호를 그리며 떠다님
    //  wobble: 빠른 주기의 작은 흔들림 → 살아있는 듯한 미세 떨림
    this.orbitAmp = 25 + Math.random() * 55;          // [25, 80] px
    this.orbitSpeedX = 3 + Math.random() * 6;         // code 단위 (실시간 0.1× 적용)
    this.orbitSpeedY = 3 + Math.random() * 6;
    this.orbitPhaseX = Math.random() * Math.PI * 2;
    this.orbitPhaseY = Math.random() * Math.PI * 2;
    this.wobbleAmp = 3 + Math.random() * 5;           // [3, 8] px
    this.wobbleSpeed = 0.8 + Math.random() * 1.7;
    this.wobblePhaseX = Math.random() * Math.PI * 2;
    this.wobblePhaseY = Math.random() * Math.PI * 2;

    // 트윙클 (반짝임)
    this.twinklePhase = Math.random() * Math.PI * 2;
    this.twinkleSpeed = 0.5 + Math.random() * 1.4;

    // 수렴 (Phase B) 파라미터
    this.absorbed = false;
    this.absorbAt = 0;
    this.flightInitialized = false;
    this.convergenceDuration = 1300 + Math.random() * 900; // 1.3~2.2s per particle
    this.startX = 0;
    this.startY = 0;
    this.swirlSign = Math.random() < 0.5 ? 1 : -1;
    this.swirlAmp = 0.05 + Math.random() * 0.09; // 호 보정 진폭 (이동 거리 대비)

    // 발산 (Phase D) 파라미터
    this.dispersing = false;
    this.dispersionAt = 0;
    this.dispersionDuration = 900 + Math.random() * 500; // 0.9~1.4s
    this.dispersionLaunched = false;
    this.dispFromX = 0;
    this.dispFromY = 0;

    // 커서 척력 누적 오프셋 — 매 프레임 0으로 lerp되며 회복
    this.cursorOffsetX = 0;
    this.cursorOffsetY = 0;
  }

  // 새로운 홈 위치만 고름 (x/y는 건드리지 않음)
  pickHome() {
    let tries = 0;
    do {
      this.homeX = Math.random() * W;
      this.homeY = Math.random() * H;
      tries++;
    } while (
      Math.hypot(this.homeX - (W * 0.5), this.homeY - (H * 0.5)) < ORB_BASE_R * 2 &&
      tries < 20
    );
  }

  // 홈 + 현재 위치 모두 새 위치로 (페이지 진입 시 사용)
  scatter() {
    this.pickHome();
    this.x = this.homeX;
    this.y = this.homeY;
  }

  // 현재 drift 오프셋을 역산해서 home을 보정 → 다음 프레임 drift가 위치 점프 없이 이어짐
  _rebaseHomeForDriftContinuity(now) {
    const tSlow = now * 0.0001;
    const tFast = now * 0.001;
    const orbX = Math.sin(tSlow * this.orbitSpeedX + this.orbitPhaseX) * this.orbitAmp;
    const orbY = Math.cos(tSlow * this.orbitSpeedY + this.orbitPhaseY) * this.orbitAmp;
    const wobX = Math.sin(tFast * this.wobbleSpeed + this.wobblePhaseX) * this.wobbleAmp;
    const wobY = Math.cos(tFast * this.wobbleSpeed * 0.83 + this.wobblePhaseY) * this.wobbleAmp;
    this.homeX = this.x - orbX - wobX;
    this.homeY = this.y - orbY - wobY;
  }

  update(now) {
    // Phase D: 발산 — IDLE_FULL 때 갇혀있던 입자가 오브에서 터져나가 새 home으로 ease-out
    if (this.dispersing && now >= this.dispersionAt) {
      if (!this.dispersionLaunched) {
        // 첫 진입: 오브 중심에서 출발, 보이게 전환, 오브 mass 감소
        this.dispFromX = orb.cx;
        this.dispFromY = orb.cy;
        this.x = orb.cx;
        this.y = orb.cy;
        this.dispersionLaunched = true;
        this.absorbed = false;
        if (orb.mass > 0) orb.mass--;
      }
      const elapsed = now - this.dispersionAt;
      const t = Math.min(1, elapsed / this.dispersionDuration);
      const eased = easeDisp(t);
      const dx = this.homeX - this.dispFromX;
      const dy = this.homeY - this.dispFromY;
      this.x = this.dispFromX + dx * eased;
      this.y = this.dispFromY + dy * eased;
      // 작은 호 보정
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const arc = Math.sin(t * Math.PI) * len * 0.04 * this.swirlSign;
      this.x += nx * arc;
      this.y += ny * arc;
      if (t >= 1) {
        // drift 진입 시 위치 점프가 없도록 home을 역계산해서 보정
        this._rebaseHomeForDriftContinuity(now);
        this.dispersing = false;
        this.dispersionLaunched = false;
      }
      return;
    }

    if (this.absorbed) return;

    if (state === State.FILLING && now >= this.absorbAt) {
      // 첫 진입 시 현재 위치를 비행 시작점으로 캡처
      if (!this.flightInitialized) {
        this.startX = this.x;
        this.startY = this.y;
        this.flightInitialized = true;
      }
      const elapsed = now - this.absorbAt;
      const t = Math.min(1, elapsed / this.convergenceDuration);
      const eased = easeConv(t);
      // 도착점은 매 프레임 현재 오브 중심 (오브가 움직이므로)
      const dx = orb.cx - this.startX;
      const dy = orb.cy - this.startY;
      this.x = this.startX + dx * eased;
      this.y = this.startY + dy * eased;
      // 곡선 보정: 진행 방향 수직으로 sin(πt) 만큼
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const arc = Math.sin(t * Math.PI) * len * this.swirlAmp * this.swirlSign;
      this.x += nx * arc;
      this.y += ny * arc;

      if (t >= 1) {
        this.absorbed = true;
        orb.mass += 1;
        orb.absorbBump += 10; // 입자 1개 흡수 시 +10px "팝", ~280ms 감쇠
        // 운동량 전달: 입자가 날아온 방향(start→orb)으로 오브를 민다.
        // 크기에 비례한 추력 — 큰 입자가 더 강하게 밀어붙임.
        const pushMag = this.coreR * 0.7;
        orb.recoilX += (dx / len) * pushMag;
        orb.recoilY += (dy / len) * pushMag;
      }
    } else {
      // Phase A: 홈 위치 주변 큰 궤도 + 작은 흔들림
      const tSlow = now * 0.0001;
      const tFast = now * 0.001;
      const orbX = Math.sin(tSlow * this.orbitSpeedX + this.orbitPhaseX) * this.orbitAmp;
      const orbY = Math.cos(tSlow * this.orbitSpeedY + this.orbitPhaseY) * this.orbitAmp;
      const wobX = Math.sin(tFast * this.wobbleSpeed + this.wobblePhaseX) * this.wobbleAmp;
      const wobY = Math.cos(tFast * this.wobbleSpeed * 0.83 + this.wobblePhaseY) * this.wobbleAmp;
      const naturalX = this.homeX + orbX + wobX;
      const naturalY = this.homeY + orbY + wobY;

      // 커서 척력 — 드리프트 중인 입자는 어떤 state에서든 cursor를 피함
      this.cursorOffsetX *= CURSOR_REPULSE_DECAY;
      this.cursorOffsetY *= CURSOR_REPULSE_DECAY;
      if (cursor.active) {
        const px = naturalX + this.cursorOffsetX;
        const py = naturalY + this.cursorOffsetY;
        const dxc = px - cursor.x;
        const dyc = py - cursor.y;
        const distSq = dxc * dxc + dyc * dyc;
        if (distSq < CURSOR_REPULSE_R_SQ && distSq > 0.5) {
          const dist = Math.sqrt(distSq);
          const t = 1 - dist / CURSOR_REPULSE_R;
          const force = t * t * CURSOR_REPULSE_GAIN; // 중심에 가까울수록 강
          this.cursorOffsetX += (dxc / dist) * force;
          this.cursorOffsetY += (dyc / dist) * force;
        }
      }

      this.x = naturalX + this.cursorOffsetX;
      this.y = naturalY + this.cursorOffsetY;
    }
  }

  draw(now) {
    if (this.absorbed) return;
    // 트윙클 — opacity 0.7 ~ 1.0 사이를 sine으로
    const tw = 0.7 + 0.3 * Math.sin(now * 0.001 * this.twinkleSpeed + this.twinklePhase);
    const alpha = this.brightness * tw;
    ctx.globalAlpha = alpha;

    // sprite를 코어 반경에 맞춰 스케일
    const scale = this.coreR / (SPRITE_RADIUS * SPRITE_CORE_FRAC);
    const drawSize = SPRITE_SIZE * scale;
    ctx.drawImage(
      particleSprite,
      this.x - drawSize / 2,
      this.y - drawSize / 2,
      drawSize,
      drawSize
    );

    // large/hero용 추가 외곽 글로우 — 화면 전체에서 시각적 앵커가 되는 입자들
    if (this.extraGlow > 0) {
      const gSize = this.coreR * 6;
      const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, gSize);
      g.addColorStop(0.0, `rgba(255,255,255,${this.extraGlow * 0.14})`);
      g.addColorStop(0.45, `rgba(255,255,255,${this.extraGlow * 0.05})`);
      g.addColorStop(1.0, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(this.x, this.y, gSize, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

const particles = [];

// ============================================================
// 오브 (=중앙의 빛 덩어리; 옛 "케이스" 역할)
//  - 흡수한 입자 수에 따라 반경이 커진다
//  - FILLING 동안 더 큰 진폭으로 드리프트 (사용자 요청)
//  - state별로 펄스 양상이 다름
// ============================================================
const orb = {
  baseCx: 0,
  baseCy: 0,
  cx: 0,
  cy: 0,
  mass: 0,
  pulsePhase: Math.random() * Math.PI * 2,
  // 매 프레임 state-목표값을 향해 lerp되는 파라미터들 — 상태 전환 시 끊김 방지
  driftAmp: 6,
  pulseAmp: 0.04,
  pulseSpeed: 1.6,
  // 드래그 / 스프링 백
  isDragging: false,
  dragPointerId: null,
  dragOffsetX: 0,
  dragOffsetY: 0,
  dragPointerX: 0,
  dragPointerY: 0,
  springX: 0,
  springY: 0,
  // 에러(임팩트) 추적
  errorImpactAt: 0,
  errorReleasedAt: 0,    // 0 = 아직 드래그 중. ERROR 상태에서 mouse up 시점 기록
  errorReleaseCx: 0,     // 손 놓은 순간의 오브 위치 (복귀 전까지 이 자리에서 진동)
  errorReleaseCy: 0,
  // 색상 진행도 — mass/PARTICLE_COUNT를 따라가지만 lerp로 부드럽게
  colorProgress: 0,
  // 흡수 직후의 일시적 크기 부풀림 — 매 프레임 감쇠
  absorbBump: 0,
  // 흡수 시 입자가 날아온 방향으로 오브가 살짝 밀리는 반동 — 매 프레임 감쇠
  recoilX: 0,
  recoilY: 0,

  update(now) {
    // 상태별 + 드래그 여부에 따른 목표값
    const targetDrift =
      this.isDragging ? 0 :
      state === State.ERROR ? 0 :                // 에러 중에는 자연 드리프트 없음 (jitter만)
      state === State.FILLING ? 38 :
      state === State.DISPERSING ? 28 :
      state === State.IDLE_FULL ? 14 : 6;
    const targetPulseAmp = state === State.IDLE_FULL ? 0.075 : 0.04;
    const targetPulseSpeed = state === State.IDLE_FULL ? 2.4 : 1.6;
    const k = 0.045;
    this.driftAmp += (targetDrift - this.driftAmp) * k;
    this.pulseAmp += (targetPulseAmp - this.pulseAmp) * k;
    this.pulseSpeed += (targetPulseSpeed - this.pulseSpeed) * k;

    // 색상 진행도: mass 기반 목표값으로 부드럽게 lerp
    // (DISPERSING/ERROR에서 mass가 급격히 줄어들 때 색이 끊기지 않도록)
    const targetColorP = Math.min(1, this.mass / PARTICLE_COUNT);
    this.colorProgress += (targetColorP - this.colorProgress) * 0.06;

    // 흡수 bump 감쇠 — 흡수 직후의 "팝"이 빠르게 가라앉음
    this.absorbBump *= 0.84;
    if (this.absorbBump < 0.05) this.absorbBump = 0;

    // 반동 감쇠 — 흡수 시 받은 운동량이 천천히 풀림 (느릴수록 변위가 오래 보임)
    this.recoilX *= 0.90;
    this.recoilY *= 0.90;
    if (Math.abs(this.recoilX) < 0.05) this.recoilX = 0;
    if (Math.abs(this.recoilY) < 0.05) this.recoilY = 0;

    // ERROR: 충격 후 진동 — 드래그 중이면 포인터, 손 뗐으면 release 위치 기준으로 jitter
    if (state === State.ERROR) {
      const f = now * 0.04;
      const jx = Math.sin(f * 1.7) * 9 + Math.sin(f * 3.1) * 5;
      const jy = Math.cos(f * 1.9) * 8 + Math.cos(f * 2.7) * 4;
      const noiseX = (Math.random() - 0.5) * 6;
      const noiseY = (Math.random() - 0.5) * 6;
      if (this.isDragging) {
        this.cx = this.dragPointerX - this.dragOffsetX + jx + noiseX;
        this.cy = this.dragPointerY - this.dragOffsetY + jy + noiseY;
      } else {
        // 손 뗀 자리에서 진동 유지 (2초 후 IDLE_EMPTY 전환 시 spring으로 복귀)
        this.cx = this.errorReleaseCx + jx + noiseX;
        this.cy = this.errorReleaseCy + jy + noiseY;
      }
      this.cx += this.recoilX;
      this.cy += this.recoilY;
      this.springX = 0;
      this.springY = 0;
      return;
    }

    if (this.isDragging) {
      // 포인터 따라가기 (grab 오프셋 유지)
      this.cx = this.dragPointerX - this.dragOffsetX + this.recoilX;
      this.cy = this.dragPointerY - this.dragOffsetY + this.recoilY;
      this.springX = 0;
      this.springY = 0;
      return;
    }

    // 자연 드리프트 + 스프링 감쇠 → 손을 떼면 원래 자리로 부드럽게 복귀
    const t = now * 0.0004;
    const amp = this.driftAmp;
    const amp2 = amp * 0.55;
    const dx = Math.sin(t * 0.8) * amp + Math.sin(t * 1.9 + 0.3) * amp2;
    const dy = Math.cos(t * 0.6) * amp + Math.cos(t * 1.5 + 0.8) * amp2;
    const naturalCx = this.baseCx + dx;
    const naturalCy = this.baseCy + dy;
    this.springX *= SPRING_DECAY;
    this.springY *= SPRING_DECAY;
    if (Math.abs(this.springX) < 0.05) this.springX = 0;
    if (Math.abs(this.springY) < 0.05) this.springY = 0;
    this.cx = naturalCx + this.springX + this.recoilX;
    this.cy = naturalCy + this.springY + this.recoilY;
  },

  // 현재 colorProgress에 해당하는 "r, g, b" 문자열 — rgba()의 첫 3채널로 바로 꽂아쓰기
  getColorRGB() {
    const p = this.colorProgress;
    for (let i = 0; i < ORB_COLOR_STOPS.length - 1; i++) {
      const a = ORB_COLOR_STOPS[i];
      const b = ORB_COLOR_STOPS[i + 1];
      if (p <= b.p) {
        const t = (p - a.p) / (b.p - a.p);
        const r = Math.round(a.r + (b.r - a.r) * t);
        const g = Math.round(a.g + (b.g - a.g) * t);
        const bb = Math.round(a.b + (b.b - a.b) * t);
        return `${r}, ${g}, ${bb}`;
      }
    }
    const last = ORB_COLOR_STOPS[ORB_COLOR_STOPS.length - 1];
    return `${last.r}, ${last.g}, ${last.b}`;
  },

  radius(now) {
    const progress = Math.min(1, this.mass / PARTICLE_COUNT);
    const eased = 1 - Math.pow(1 - progress, 1.7);
    const baseR = ORB_BASE_R + (ORB_MAX_R - ORB_BASE_R) * eased;
    let pulse = 1 + Math.sin(now * 0.001 * this.pulseSpeed + this.pulsePhase) * this.pulseAmp;
    // ERROR: 반경에 빠른 펄스 추가 — "찌릿"
    if (state === State.ERROR) {
      const f = now * 0.04;
      pulse += Math.sin(f * 4) * 0.10 + Math.sin(f * 7.3) * 0.06;
    }
    return baseR * pulse + this.absorbBump;
  },

  draw(now) {
    const r = this.radius(now);
    const color = this.getColorRGB();

    // halo 레이어들 — 색조가 들어감 (가장 큰 글로우부터)
    drawHalo(this.cx, this.cy, r * 4.6, 0.060, color);
    drawHalo(this.cx, this.cy, r * 2.7, 0.14,  color);
    drawHalo(this.cx, this.cy, r * 1.55, 0.32, color);

    // 코어 — 중앙은 순백(빛의 진원지) → 가장자리로 갈수록 inner shadow로 채색
    // ERROR 상태에서는 wobbly path로 형태 자체가 우글거림
    const g = ctx.createRadialGradient(
      this.cx, this.cy, 0,
      this.cx, this.cy, r
    );
    g.addColorStop(0.00, "rgba(255,255,255,1)");
    g.addColorStop(0.40, "rgba(255,255,255,0.92)");
    g.addColorStop(0.75, `rgba(${color}, 0.78)`);  // inner shadow zone — 색조
    g.addColorStop(0.95, `rgba(${color}, 0.30)`);
    g.addColorStop(1.00, `rgba(${color}, 0)`);
    ctx.fillStyle = g;
    orbCorePath(this.cx, this.cy, r, state === State.ERROR ? 1 : 0, now);
    ctx.fill();
  },
};

// 오브 코어 path — wobble=0이면 단순 원, wobble>0이면 다중 sine harmonic으로 우글거림
function orbCorePath(cx, cy, r, wobble, now) {
  if (wobble < 0.01) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    return;
  }
  const segments = 40;
  const t = now * 0.012;
  ctx.beginPath();
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const raw =
      Math.sin(a * 3 + t * 5) * 0.20 +
      Math.sin(a * 5 - t * 7) * 0.13 +
      Math.sin(a * 8 + t * 11) * 0.07;
    // 약간 inward 편향 + 짧은 random spike → "찌릿"
    const spike = (Math.random() - 0.7) * 0.06;
    const w = (raw + spike) * wobble * r;
    const rr = Math.max(r * 0.35, r + w);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawHalo(x, y, r, alpha, color = "255, 255, 255") {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0.0, `rgba(${color}, ${alpha})`);
  g.addColorStop(0.4, `rgba(${color}, ${alpha * 0.35})`);
  g.addColorStop(1.0, `rgba(${color}, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// ============================================================
// 방해 — 드래그·흔들기 → 입자 사출
// ============================================================
function processShake(now) {
  if (!orb.isDragging) {
    shakeAccumulator *= SHAKE_DECAY;
    if (shakeAccumulator < 0.5) shakeAccumulator = 0;
    return;
  }
  if (pointerHistory.length < 2) return;

  // 최근 N ms 동안의 누적 이동 거리 / 시간 = 평균 속도(px/ms).
  // 단순 displacement가 아니라 "총 이동 거리"라서 좌우로 흔들면 빠르게 누적됨.
  let totalDist = 0;
  for (let i = 1; i < pointerHistory.length; i++) {
    totalDist += Math.hypot(
      pointerHistory[i].x - pointerHistory[i - 1].x,
      pointerHistory[i].y - pointerHistory[i - 1].y
    );
  }
  const dt = pointerHistory[pointerHistory.length - 1].t - pointerHistory[0].t;
  if (dt < 1) return;
  const speed = totalDist / dt;

  shakeAccumulator = (shakeAccumulator + speed * SHAKE_INPUT_GAIN) * SHAKE_DECAY;

  while (
    shakeAccumulator > SHAKE_EJECT_THRESHOLD &&
    now - lastEjectAt > SHAKE_COOLDOWN_MS
  ) {
    ejectParticle(speed);
    shakeAccumulator -= SHAKE_EJECT_THRESHOLD * SHAKE_EJECT_DRAIN;
    lastEjectAt = now;
  }
}

// ============================================================
// 에러: 가장자리 강한 임팩트 감지 + 트리거
// ============================================================
function checkImpact(now) {
  if (!orb.isDragging) return;
  if (state === State.ERROR) return; // 이미 에러
  if (pointerHistory.length < 2) return;

  // 최근 ~30ms 동안의 평균 속도 벡터 (방향 + 크기)
  const newest = pointerHistory[pointerHistory.length - 1];
  let oldIdx = pointerHistory.length - 1;
  while (oldIdx > 0 && newest.t - pointerHistory[oldIdx - 1].t < 30) oldIdx--;
  const old = pointerHistory[oldIdx];
  const dt = newest.t - old.t;
  if (dt < 1) return;
  const vx = (newest.x - old.x) / dt;
  const vy = (newest.y - old.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed < IMPACT_SPEED_THRESHOLD) return;

  // 오브가 가장자리 근처 + 그 가장자리 방향으로 움직이는 중인지 확인
  const m = IMPACT_EDGE_MARGIN;
  const hitLeft   = orb.cx < m         && vx < -0.3;
  const hitRight  = orb.cx > W - m     && vx >  0.3;
  const hitTop    = orb.cy < m         && vy < -0.3;
  const hitBottom = orb.cy > H - m     && vy >  0.3;

  if (hitLeft || hitRight || hitTop || hitBottom) {
    triggerError(Math.atan2(vy, vx), speed, now);
  }
}

function triggerError(impactAngle, intensity, now) {
  state = State.ERROR;
  orb.errorImpactAt = now;
  orb.errorReleasedAt = 0;

  // 입자 폭발 방향: 커서 힘 방향의 반대 (살짝 방사형 spread)
  const burstAngle = impactAngle + Math.PI;

  for (const p of particles) {
    if (p.dispersing) continue; // 이미 흩어지는 중인 입자는 건드리지 않음

    if (p.absorbed) {
      // 오브 안에 있는 입자 → 반대 방향 콘으로 사출 (기존 dispersion 로직 재활용)
      const ang = burstAngle + (Math.random() - 0.5) * ERROR_BURST_SPREAD;
      const dist = 160 + Math.random() * 220 + intensity * 90;
      let tx = orb.cx + Math.cos(ang) * dist;
      let ty = orb.cy + Math.sin(ang) * dist;
      tx = Math.max(40, Math.min(W - 40, tx));
      ty = Math.max(40, Math.min(H - 40, ty));
      p.homeX = tx;
      p.homeY = ty;
      p.dispersing = true;
      p.dispersionAt = now + Math.random() * 180;       // 0~180ms 짧은 stagger → 일제히 터지는 느낌
      p.dispersionLaunched = false;
      p.dispersionDuration = 500 + Math.random() * 600;
      p.flightInitialized = false;
    } else if (p.flightInitialized) {
      // 수렴 중이던 입자 → 비행 중단, 현재 위치 기준으로 drift 이음매 없이 자연 합류
      p.flightInitialized = false;
      p._rebaseHomeForDriftContinuity(now);
    }
    // 자유 드리프트 중인 입자는 그대로 둠 (상태가 곧 IDLE_EMPTY가 되므로 absorbAt도 무시됨)
  }
}

function ejectParticle(intensity) {
  // 현재 오브 안에 있는 입자(=absorbed, dispersing 아님) 중 하나를 골라 사출
  const candidates = [];
  for (const p of particles) {
    if (p.absorbed && !p.dispersing) candidates.push(p);
  }
  if (candidates.length === 0) return;
  const p = candidates[(Math.random() * candidates.length) | 0];
  const now = performance.now();

  // 사출 방향(무작위) + 거리(흔드는 강도에 비례)
  const ang = Math.random() * Math.PI * 2;
  const dist = 90 + Math.min(intensity, 2.5) * 180; // [90, 540]
  let tx = orb.cx + Math.cos(ang) * dist;
  let ty = orb.cy + Math.sin(ang) * dist;
  // 화면 안쪽으로 클램프
  tx = Math.max(40, Math.min(W - 40, tx));
  ty = Math.max(40, Math.min(H - 40, ty));
  p.homeX = tx;
  p.homeY = ty;

  // 기존 dispersion 로직을 1개 단위로 재사용 — 오브 중심에서 ease-out으로 튀어나가 home 안착
  p.dispersing = true;
  p.dispersionAt = now;
  p.dispersionLaunched = false;
  p.dispersionDuration = 350 + Math.min(intensity, 2.5) * 250; // [350, 975] ms
  p.flightInitialized = false;

  // 재흡수 일정: 현재 큐의 가장 늦은 absorbAt 뒤에 평균 gap만큼 더해 예약
  // → "같은 속도로 다시 모인다"는 원래 스펙을 만족
  const avgGap = TOTAL_FILL_MS / PARTICLE_COUNT;
  let latestAbsorbAt = now + p.dispersionDuration;
  for (const pp of particles) {
    if (!pp.absorbed && !pp.dispersing && pp.absorbAt > latestAbsorbAt) {
      latestAbsorbAt = pp.absorbAt;
    }
  }
  p.absorbAt = latestAbsorbAt + avgGap + Math.random() * 300;
}

// ============================================================
// 렌더 루프
// ============================================================
function frame(now) {
  // 트레일: source-over로 검정 알파 깔아서 잔상 (모션블러 느낌)
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(0,0,0,${TRAIL_FADE})`;
  ctx.fillRect(0, 0, W, H);

  // 업데이트
  checkImpact(now);
  processShake(now);
  orb.update(now);
  for (const p of particles) p.update(now);

  // additive blending — 겹친 빛이 더 밝아짐
  ctx.globalCompositeOperation = "lighter";
  for (const p of particles) p.draw(now);
  orb.draw(now);

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  // 상태 전환: FILLING 중 모든 입자 흡수되면 IDLE_FULL
  if (state === State.FILLING && orb.mass >= PARTICLE_COUNT) {
    state = State.IDLE_FULL;
  }

  // DISPERSING 중 모든 입자가 발산을 끝마치면 → 텅 빈 대기를 거쳐 곧장 FILLING으로 순환
  if (state === State.DISPERSING) {
    let stillDispersing = false;
    for (const p of particles) {
      if (p.dispersing) { stillDispersing = true; break; }
    }
    if (!stillDispersing) {
      // 한 프레임 IDLE_EMPTY → 즉시 startFilling. 시각적으로는 흩어진 입자들이
      // 자기 자리에 도착하자마자 다시 트리클거리며 빨려들기 시작.
      state = State.IDLE_EMPTY;
      startFilling(now);
    }
  }

  // ERROR: 손을 떼고 ERROR_HOLD_MS가 지나면 IDLE_EMPTY로 부드럽게 복귀
  // — 기존 spring 메커니즘으로 현재 위치 → baseCx/Cy 자연 드리프트 위치로 감쇠
  if (
    state === State.ERROR &&
    orb.errorReleasedAt > 0 &&
    now - orb.errorReleasedAt > ERROR_HOLD_MS
  ) {
    const t = now * 0.0004;
    const amp = orb.driftAmp; // 곧 6으로 lerp되겠지만, 현재 값을 자연 위치 계산에 사용
    const amp2 = amp * 0.55;
    const dx = Math.sin(t * 0.8) * amp + Math.sin(t * 1.9 + 0.3) * amp2;
    const dy = Math.cos(t * 0.6) * amp + Math.cos(t * 1.5 + 0.8) * amp2;
    const naturalCx = orb.baseCx + dx;
    const naturalCy = orb.baseCy + dy;
    orb.springX = orb.cx - naturalCx;
    orb.springY = orb.cy - naturalCy;
    state = State.IDLE_EMPTY;
  }

  requestAnimationFrame(frame);
}

// ============================================================
// 인터랙션
// ============================================================
function isOnOrb(x, y, slack = 20) {
  const r = orb.radius(performance.now());
  // halo까지 클릭 가능하게 여유
  return Math.hypot(x - orb.cx, y - orb.cy) <= r + slack;
}

canvas.addEventListener("click", (e) => {
  // 드래그가 발생했다면 click 무시 (setPointerCapture된 시점부터 click은 일반적으로 안 뜨지만 안전장치)
  if (orb.isDragging || orb.dragPointerId !== null) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (!isOnOrb(x, y, 28)) return;

  if (state === State.IDLE_EMPTY) {
    startFilling(performance.now());
  } else if (state === State.IDLE_FULL) {
    startDispersing(performance.now());
  }
});

// ============================================================
// 방해 트리거 — 포인터 이벤트
//  - FILLING 중일 때만 오브를 잡아 드래그/흔들기 가능
//  - IDLE_EMPTY / IDLE_FULL의 클릭은 위 click 핸들러가 처리
// ============================================================
canvas.addEventListener("pointerdown", (e) => {
  if (state !== State.FILLING) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (!isOnOrb(x, y, 28)) return;

  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  orb.isDragging = true;
  orb.dragPointerId = e.pointerId;
  orb.dragOffsetX = x - orb.cx;
  orb.dragOffsetY = y - orb.cy;
  orb.dragPointerX = x;
  orb.dragPointerY = y;
  pointerHistory.length = 0;
  pointerHistory.push({ x, y, t: performance.now() });
  canvas.style.cursor = "grabbing";
});

canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // 커서 위치 항상 추적 (드래그 여부와 무관) — 입자 척력에 사용
  cursor.x = x;
  cursor.y = y;
  cursor.active = true;

  if (orb.isDragging && e.pointerId === orb.dragPointerId) {
    orb.dragPointerX = x;
    orb.dragPointerY = y;
    const now = performance.now();
    pointerHistory.push({ x, y, t: now });
    while (pointerHistory.length > 1 && now - pointerHistory[0].t > POINTER_HISTORY_MS) {
      pointerHistory.shift();
    }
    return;
  }

  // 호버 시 커서 표시 (드래그 중이 아닐 때만)
  const over = isOnOrb(x, y, 12);
  if (over && state === State.FILLING) canvas.style.cursor = "grab";
  else if (over && (state === State.IDLE_EMPTY || state === State.IDLE_FULL)) canvas.style.cursor = "pointer";
  else canvas.style.cursor = "default";
});

function endDrag(e) {
  if (!orb.isDragging) return;
  if (e && orb.dragPointerId !== null && e.pointerId !== orb.dragPointerId) return;

  const now = performance.now();

  if (state === State.ERROR) {
    // 손 뗀 시점과 위치 기록 → ERROR_HOLD_MS 동안 그 자리에서 진동 유지
    orb.errorReleaseCx = orb.cx;
    orb.errorReleaseCy = orb.cy;
    orb.errorReleasedAt = now;
    // 스프링은 0으로 두고, 2초 후 IDLE_EMPTY 전환 시점에 캡처해서 부드럽게 복귀
    orb.springX = 0;
    orb.springY = 0;
  } else {
    // 일반 드래그 종료 — 스프링 캡처해서 원래 자리로 복귀
    const t = now * 0.0004;
    const amp = orb.driftAmp;
    const amp2 = amp * 0.55;
    const dx = Math.sin(t * 0.8) * amp + Math.sin(t * 1.9 + 0.3) * amp2;
    const dy = Math.cos(t * 0.6) * amp + Math.cos(t * 1.5 + 0.8) * amp2;
    const naturalCx = orb.baseCx + dx;
    const naturalCy = orb.baseCy + dy;
    orb.springX = orb.cx - naturalCx;
    orb.springY = orb.cy - naturalCy;
  }

  orb.isDragging = false;
  try {
    if (orb.dragPointerId !== null) canvas.releasePointerCapture(orb.dragPointerId);
  } catch (_) {}
  orb.dragPointerId = null;
  pointerHistory.length = 0;
  canvas.style.cursor = "default";
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("pointerleave", (e) => {
  // 포인터가 캡처된 상태면 leave가 안 뜨지만, 캡처 실패한 경우 안전장치
  if (orb.isDragging && e.pointerId === orb.dragPointerId) endDrag(e);
  cursor.active = false; // 척력 비활성 → 입자가 본 자리로 lerp 복귀
});

function startFilling(now) {
  state = State.FILLING;
  orb.mass = 0;

  // 입자별 absorbAt을 0 ~ TOTAL_FILL_MS-3000 사이로 분산 + 약간의 jitter
  const order = particles.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const window = TOTAL_FILL_MS - 3000;
  for (let i = 0; i < order.length; i++) {
    const p = particles[order[i]];
    p.absorbed = false;
    p.flightInitialized = false;
    p.absorbAt = now + (i / (order.length - 1)) * window + (Math.random() - 0.5) * 700;
  }
  hint.classList.add("hidden");
}

function startDispersing(now) {
  // IDLE_FULL에서 모든 입자가 오브 안에 있는 상태에서 시작
  state = State.DISPERSING;
  // 입자별 새 home 결정 + 발산 시점 stagger
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.pickHome();              // 도착점만 미리 정하고 x/y는 건드리지 않음
    p.dispersing = true;
    p.dispersionLaunched = false;
    p.dispersionAt = now + Math.random() * 500; // 0~500ms stagger
    p.dispersionDuration = 900 + Math.random() * 500;
    // FILLING 잔여 플래그 정리
    p.flightInitialized = false;
    p.absorbed = true; // launch 전까지는 오브 안에 잠겨있다고 가정 (mass에 포함)
  }
  // 안전장치: 실제 absorbed=true 입자 수와 mass 동기화
  let absorbedNow = 0;
  for (const p of particles) if (p.absorbed) absorbedNow++;
  orb.mass = absorbedNow;
  hint.classList.add("hidden");
}

// ============================================================
// 부팅
// ============================================================
window.addEventListener("resize", resize);
resize();
for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(new Particle());
// resize 이후에 만들어진 입자는 W/H가 이미 셋업된 상태라 OK이지만,
// 안전하게 한 번 더 scatter (보장)
for (const p of particles) p.scatter();
requestAnimationFrame(frame);
