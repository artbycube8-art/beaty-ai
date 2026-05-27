/**
 * Beauty AI SaaS — Cloudflare Worker
 * Multi-bot Telegram platform for barber / makeup / nails salons (Kazakhstan)
 *
 * Client webhook:  POST /webhook/:bot_token
 * Admin webhook:   POST /admin-webhook
 *
 * Required secrets (wrangler secret put <NAME>):
 *   FAL_KEY          — fal.ai API key
 *   ADMIN_BOT_TOKEN  — token of your admin panel bot (@BotFather)
 *   ADMIN_USER_ID    — your Telegram user ID (@userinfobot)
 *
 * Required var (wrangler.jsonc → vars):
 *   WORKER_URL       — e.g. https://beauty-ai-saas.artbycube8.workers.dev
 *
 * Required D1 binding:  beauty_ai_db
 */

const TELEGRAM_API = 'https://api.telegram.org';
const FAL_API      = 'https://fal.run';

// ─── Conversation states ──────────────────────────────────────────────────────
const S = {
  WAITING_CONTACT : 'waiting_contact',
  WAITING_SELFIE       : 'waiting_selfie',        // barber: step 1 — face photo
  WAITING_STYLE_CHOICE : 'waiting_style_choice', // barber: step 2 — gender → style picker
  WAITING_COLOR        : 'waiting_color',         // barber: step 3 — color picker
  WAITING_FACE    : 'waiting_face',     // makeup: step 1 — face photo
  WAITING_HAND    : 'waiting_hand',     // nails:  step 1 — hand photo
  PROCESSING      : 'processing',       // fal.ai job submitted, waiting for callback
  DONE            : 'done',
  // Salon owner push flow
  SALON_PUSH_TEXT    : 'salon_push_text',
  SALON_PUSH_BUTTONS : 'salon_push_buttons',
  SALON_PUSH_CONFIRM : 'salon_push_confirm',
  // Salon owner tariff flow
  SALON_TARIFF_RECEIPT: 'salon_tariff_receipt',
  // Salon owner settings/edit flow
  SALON_EDIT_NAME  : 'salon_edit_name',
  SALON_EDIT_PHONE : 'salon_edit_phone',
  // B2B owner onboarding (inside Standard bot)
  B2B_NAME            : 'b2b_name',
  B2B_PHONE           : 'b2b_phone',
  B2B_TYPE            : 'b2b_type',    // type selection step between name and phone
  // B2B payment flow
  B2B_AWAITING_PHONE       : 'b2b_awaiting_phone',
  B2B_AWAITING_CHEQUE      : 'b2b_awaiting_cheque',
  B2B_CONFIRMATION_PENDING : 'b2b_confirmation_pending', // anti-spam lock after cheque sent
  B2B_AWAITING_TOKEN       : 'b2b_awaiting_token',
};

// ─── Subscription tariffs ─────────────────────────────────────────────────────
const TARIFFS = {
  start: { name: 'Старт',   limit: 150,  price: 9900  },
  basic: { name: 'Базовый', limit: 300,  price: 14900 },
  pro:   { name: 'Про',     limit: 600,  price: 24900 },
  max:   { name: 'Макс',    limit: 1200, price: 39900 },
};

const B2B_PACKAGES = {
  b2b_pkg_mini_shared : { name: 'Мини',     price: 9900,  gens: 150,  own: false, short: 'mi_s' },
  b2b_pkg_std_shared  : { name: 'Стандарт', price: 14900, gens: 300,  own: false, short: 'st_s' },
  b2b_pkg_biz_shared  : { name: 'Бизнес',   price: 24900, gens: 600,  own: false, short: 'bi_s' },
  b2b_pkg_net_shared  : { name: 'Сеть',     price: 44900, gens: 1200, own: false, short: 'ne_s' },
  b2b_pkg_mini_own    : { name: 'Мини',     price: 34900, gens: 150,  own: true,  short: 'mi_o' },
  b2b_pkg_std_own     : { name: 'Стандарт', price: 39900, gens: 300,  own: true,  short: 'st_o' },
  b2b_pkg_biz_own     : { name: 'Бизнес',   price: 49900, gens: 600,  own: true,  short: 'bi_o' },
  b2b_pkg_net_own     : { name: 'Сеть',     price: 69900, gens: 1200, own: true,  short: 'ne_o' },
};

// Reverse map: short code → full package key (for admin callback parsing)
const PKG_SHORT = Object.fromEntries(
  Object.entries(B2B_PACKAGES).map(([k, v]) => [v.short, k])
);

const FAL_QUEUE = 'https://queue.fal.run';

// ─── Barber presets — FLUX Kontext editing instructions ──────────────────────
// Two FACE_LOCK variants — gender-specific so the model never confuses identity.
// Prepended to every prompt so the model reads it first.
const FACE_LOCK_M = 'ABSOLUTE RULE: The person in this photo is MALE. DO NOT change the face, masculine bone structure, jawline, brow ridge, eyes, nose, mouth, chin, ears, neck, skin tone, or any facial feature. DO NOT feminize the face or any part of it under any circumstances. The face must be pixel-identical to the input. ONLY edit the hair on the scalp. Keep clothing, background, pose, and lighting unchanged. HAIR EDIT ONLY: ';
const FACE_LOCK_F = 'ABSOLUTE RULE: The person in this photo is FEMALE. DO NOT change the face, feminine bone structure, eyes, nose, mouth, chin, cheekbones, ears, neck, skin tone, or any facial feature. DO NOT masculinize the face or any part of it under any circumstances. The face must be pixel-identical to the input. ONLY edit the hair on the scalp. Keep clothing, background, pose, and lighting unchanged. HAIR EDIT ONLY: ';

const MALE_STYLES = {
  // ── Сохранить ──────────────────────────────────────────────────────────────
  default    : { label: '✅ Свою причёску',      hairPrompt: "Keep the exact current hairstyle completely unchanged — same haircut, same length, same style. Only apply color changes if specified." },
  // ── Короткие ───────────────────────────────────────────────────────────────
  buzz       : { label: '⚡ Buzz Cut',           hairPrompt: "Change ONLY the hair into a buzz cut: uniformly very short (~6mm grade 2) over the entire head — top, sides, and back all equally short." },
  crewcut    : { label: '🪖 Кру кат',            hairPrompt: "Change ONLY the hair into a crew cut: very short tapered sides fading to skin, slightly longer flat textured top (1-2cm), clean military-style lines." },
  caesar     : { label: '🏛 Цезарь',             hairPrompt: "Change ONLY the hair into a Caesar cut: short uniform hair all over (2-3cm) with a distinct straight horizontal fringe across the forehead, no fade." },
  // ── Фейды ──────────────────────────────────────────────────────────────────
  fade       : { label: '🔪 Фейд',              hairPrompt: "Change ONLY the hair into a bald fade: sides and back shaved to skin at the bottom, gradually blending upward into 3-5cm of textured hair on top. Sharp temple and neckline lineup." },
  taper      : { label: '🎯 Тейпер',            hairPrompt: "Change ONLY the hair into a modern taper fade: sides taper from medium at the top down to skin-short at the bottom, top has 4-6cm of textured hair." },
  frenchcrop : { label: '🌾 Французский кроп',  hairPrompt: "Change ONLY the hair into a French crop: short textured hair on top (2-3cm) with a clear straight horizontal fringe at eyebrow level, sides faded very short." },
  edgar      : { label: '⬛ Эдгар',              hairPrompt: "Change ONLY the hair into an Edgar cut: flat short hair on top (2-3cm) with a perfectly straight blunt horizontal fringe at the forehead, sides faded very short, boxy rectangular top." },
  // ── Укладки ────────────────────────────────────────────────────────────────
  slickback  : { label: '💆 Слик бэк',          hairPrompt: "Change ONLY the hair into a slick back: all hair on top combed straight backward from forehead to nape in a smooth glossy wet-look flow, short faded sides." },
  quiff      : { label: '🌟 Квифф',             hairPrompt: "Change ONLY the hair into a quiff: front section swept upward and back creating clear dramatic height and volume above the forehead, sides faded short." },
  pompadour  : { label: '💈 Помпадур',          hairPrompt: "Change ONLY the hair into a pompadour: large volume swept dramatically upward and backward from the forehead, significant height at the front, sides tapered short." },
  undercut   : { label: '✂️ Андеркат',          hairPrompt: "Change ONLY the hair into an undercut: sides and back shaved nearly to skin, top hair stays long (5-8cm) slicked or swept back, stark contrast line between short sides and longer top." },
  fauxhawk   : { label: '🦅 Фохок',             hairPrompt: "Change ONLY the hair into a faux hawk: sides faded very short, strip of hair down the center of the head styled upward into a ridge, less extreme than a mohawk." },
  // ── Средняя длина ──────────────────────────────────────────────────────────
  twoblock   : { label: '🎌 Two-block',          hairPrompt: "Change ONLY the hair into a two-block cut: sides and back cut very short or faded, top left significantly longer (7-10cm) and styled forward or to the side, clear division between short sides and long top. Popular K-pop style." },
  curtainmen : { label: '🪞 Кёртины (пробор)',   hairPrompt: "Change ONLY the hair into a curtain hairstyle: medium length hair (8-12cm) with a center part, falling to both sides and framing the face, natural flow, slightly wavy texture allowed." },
  mullet     : { label: '🎸 Мулет',             hairPrompt: "Change ONLY the hair into a mullet: short cropped on the top and sides, distinctly longer in the back (reaching the nape or collar), clear contrast between short front/sides and longer back." },
  // ── Кудри (три варианта) ───────────────────────────────────────────────────
  curlyshort : { label: '🌀 Кудри короткие',    hairPrompt: "Change ONLY the hair into short curly hair: tight coils or defined curls all over the head, 2-4cm length, natural afro-textured or coily look." },
  curlymed   : { label: '🌀 Кудри средние',     hairPrompt: "Change ONLY the hair into medium-length curly hair: defined bouncy curls 6-10cm long covering the top and sides, full volume, natural curl pattern." },
  curlylong  : { label: '🌀 Кудри длинные',     hairPrompt: "Change ONLY the hair into long curly hair: loose big curls or waves reaching past the ears and neck, 12-18cm long, voluminous and flowing." },
  // ── Длинные ────────────────────────────────────────────────────────────────
  longback   : { label: '🧖 Длинные назад',     hairPrompt: "Change ONLY the hair to long hair (past shoulders) neatly slicked or tied back, sleek and straight, masculine long hairstyle." },
};

const FEMALE_STYLES = {
  // ── Сохранить ──────────────────────────────────────────────────────────────
  default     : { label: '✅ Свою причёску',    hairPrompt: "Keep the exact current hairstyle completely unchanged — same haircut, same length, same style. Only apply color changes if specified." },
  // ── Короткие ───────────────────────────────────────────────────────────────
  pixie       : { label: '💫 Пикси',            hairPrompt: "Change ONLY the hair into a pixie cut: very short all over (2-4cm), slightly longer textured pieces on top, edgy modern style." },
  frenchbob   : { label: '🥐 Французское каре', hairPrompt: "Change ONLY the hair into a French bob: short blunt bob cut at chin level or just above, voluminous rounded shape, often with a fringe." },
  // ── Каре (bob family) ──────────────────────────────────────────────────────
  bob         : { label: '✂️ Каре',             hairPrompt: "Change ONLY the hair into a classic bob: straight hair cut precisely to jaw length with blunt ends, sleek and symmetrical." },
  angledBob   : { label: '📐 Каре с удлинением', hairPrompt: "Change ONLY the hair into an angled bob: shorter in the back and gradually longer toward the front, sleek diagonal line, sophisticated look." },
  lob         : { label: '💁 Лоб (удл. каре)',  hairPrompt: "Change ONLY the hair into a long bob (lob): sleek straight hair cut at collarbone length with blunt ends." },
  // ── Средняя длина ──────────────────────────────────────────────────────────
  curtainbangs: { label: '🎭 Шторки',           hairPrompt: "Add ONLY curtain bangs to the existing hair: soft middle-parted wispy bangs framing the face on both sides, keep all other hair unchanged." },
  shag        : { label: '🪨 Шэг',              hairPrompt: "Change ONLY the hair into a shag haircut: choppy layered hair at medium length with lots of texture, wispy ends, and airy volume throughout, piece-y curtain bangs optional." },
  wolfcut     : { label: '🐺 Волчья стрижка',  hairPrompt: "Change ONLY the hair into a wolf cut shag: heavily layered with curtain bangs, lots of volume at the crown, wispy textured ends at medium length." },
  butterfly   : { label: '🦋 Баттерфляй',      hairPrompt: "Change ONLY the hair into a butterfly cut: shorter face-framing layers at the crown creating wings and visible volume, longer layers below for a dramatic contrast." },
  // ── Длинные ────────────────────────────────────────────────────────────────
  longstraight: { label: '👸 Длинные прямые',   hairPrompt: "Change ONLY the hair to long straight silky hair flowing well past the shoulders, smooth and sleek." },
  layers      : { label: '🌿 Каскад',           hairPrompt: "Change ONLY the hair into long layered cascading hair with soft flowing layers, volume and movement well past the shoulders." },
  bluntlong   : { label: '📏 Длинные ровные',   hairPrompt: "Change ONLY the hair to long one-length blunt cut: all hair the same length falling straight past the shoulders, no layers, strong blunt ends." },
  // ── Кудри и волны ──────────────────────────────────────────────────────────
  curlylong   : { label: '🌊 Локоны длинные',   hairPrompt: "Change ONLY the hair to long curly: big defined bouncy curls flowing well past the shoulders, glamorous volume." },
  curlymed    : { label: '🌀 Локоны средние',   hairPrompt: "Change ONLY the hair to medium-length curly hair: defined curls reaching the chin or shoulders, full and springy." },
  beachwaves  : { label: '🏄 Пляжные волны',    hairPrompt: "Change ONLY the hair into beach waves: loose effortless waves at medium-to-long length, natural tousled texture, lived-in look." },
  // ── Укладки ────────────────────────────────────────────────────────────────
  ponytail    : { label: '🎀 Хвостик',          hairPrompt: "Change ONLY the hair into a sleek high ponytail: all hair pulled back smoothly and tied high on the head, no loose strands." },
  bun         : { label: '🩰 Пучок',            hairPrompt: "Change ONLY the hair into a neat high bun: all hair twisted and pinned high on the crown of the head, polished and elegant." },
  braid       : { label: '🧶 Коса',             hairPrompt: "Change ONLY the hair into a side braid: a thick classic three-strand braid falling over one shoulder, rest of hair tucked in." },
};

const HAIR_COLORS = {
  skip     : { label: '✅ Мой цвет',          colorPrompt: null },
  black    : { label: '⚫ Чёрный',            colorPrompt: 'dyed jet black hair color' },
  darkbrown: { label: '🟤 Тёмно-коричн.',     colorPrompt: 'dark chocolate brown hair color' },
  brown    : { label: '🟫 Шатен',             colorPrompt: 'warm medium chestnut brown hair color' },
  blonde   : { label: '👱 Блонд',             colorPrompt: 'golden blonde hair color' },
  ashblonde: { label: '🌸 Пепельный',         colorPrompt: 'cool ash blonde hair color' },
  red      : { label: '🔴 Рыжий/Медный',      colorPrompt: 'vibrant copper red auburn hair color' },
};


// ─── Public Oferta HTML ─────────────────────────────────────────────────────
const OFERTA_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Публичная оферта — Beauty AI</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.7;
    color: #1a1a1a;
    background: #fff;
    padding: 0;
  }

  .document {
    max-width: 800px;
    margin: 0 auto;
    padding: 60px 50px;
  }

  .lang-block {
    page-break-after: always;
  }

  .brand {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.5px;
    margin-bottom: 4px;
  }

  .brand span { color: #7c3aed; }

  .doc-title {
    font-size: 20px;
    font-weight: 700;
    margin: 28px 0 4px;
    letter-spacing: -0.3px;
  }

  .doc-meta {
    font-size: 12px;
    color: #666;
    margin-bottom: 36px;
    padding-bottom: 24px;
    border-bottom: 1px solid #e5e5e5;
  }

  h2 {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #7c3aed;
    margin: 32px 0 10px;
  }

  h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 20px 0 8px;
  }

  p {
    margin-bottom: 10px;
    color: #333;
  }

  ul, ol {
    padding-left: 20px;
    margin-bottom: 10px;
  }

  li {
    margin-bottom: 5px;
    color: #333;
  }

  .section {
    margin-bottom: 4px;
  }

  .highlight {
    background: #f5f3ff;
    border-left: 3px solid #7c3aed;
    padding: 12px 16px;
    margin: 14px 0;
    border-radius: 0 6px 6px 0;
  }

  .highlight p { margin: 0; color: #4a4a4a; }

  .divider {
    border: none;
    border-top: 1px solid #e5e5e5;
    margin: 40px 0;
  }

  .requisites {
    background: #fafafa;
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    padding: 20px 24px;
    margin-top: 24px;
  }

  .requisites p { margin-bottom: 4px; font-size: 13px; }
  .requisites strong { color: #1a1a1a; }

  .page-break { page-break-before: always; }

  @media print {
    body { font-size: 12px; }
    .document { padding: 30px 24px; }
    .lang-block { page-break-after: always; }
    h2 { font-size: 11px; }
  }
</style>
</head>
<body>
<div class="document">

<!-- ═══════════════════════════════════════════════════
     ҚАЗАҚША НҰСҚА
══════════════════════════════════════════════════════ -->
<div class="lang-block">

<div class="brand">Beauty <span>AI</span></div>
<div class="doc-title">ЖАРИЯ ОФЕРТА</div>
<div class="doc-meta">
  Telegram-бот арқылы AI-сурет генерациясы қызметіне қосылу туралы<br>
  Редакция: 2026 жылғы 26 мамыр &nbsp;|&nbsp; Нұсқа 1.0
</div>

<h2>1. Жалпы ережелер</h2>
<p>1.1. Осы құжат Қазақстан Республикасының азаматтық заңнамасына сәйкес жария офертаны (бұдан әрі — «Оферта») білдіреді.</p>
<p>1.2. Офертаны ұсынушы — Beauty AI сервисінің операторы (бұдан әрі — «Оператор»), жеке кәсіпкер ретінде тіркелген.</p>
<p>1.3. Оферта Telegram-арнасы немесе веб-сайт арқылы сервиске қол жеткізетін кез келген заңды немесе жеке тұлғаға (бұдан әрі — «Тапсырыс беруші») арналған.</p>
<p>1.4. Офертаның барлық шарттарын толық қабылдау (акцепт) Тапсырыс берушінің кез келген тарифті төлеуін немесе сервисті іске қосуын білдіреді.</p>

<h2>2. Офертаның нысаны</h2>
<p>2.1. Оператор Тапсырыс берушіге Beauty AI SaaS платформасына қол жеткізуді ұсынады — бұл Telegram-бот арқылы жұмыс істейтін, AI технологиясын пайдаланып тұтынушылардың фотографияларын өңдейтін автоматтандырылған жазылым қызметі.</p>
<p>2.2. Қызметтің негізгі функциялары:</p>
<ul>
  <li>тұтынушылардың селфі-суреттерінен AI-генерациялық бейнелерін жасау;</li>
  <li>сауда нүктелеріне арналған Telegram-ботты баптау мен басқару;</li>
  <li>тіркелген тарифке байланысты генерация лимиттерін орнату;</li>
  <li>сауда нүктесінің тұтынушылар базасы бойынша хабарлама жіберу;</li>
  <li>статистика мен басқару панеліне (admin panel) қол жеткізу.</li>
</ul>

<h2>3. Сервисті пайдалану</h2>
<p>3.1. Сервиске тек шақыру сілтемесі немесе ресми B2B-арна арқылы қол жеткізуге болады.</p>
<p>3.2. Тапсырыс беруші міндетті:</p>
<ul>
  <li>жоғарылатылған деректерді ұсынбауға;</li>
  <li>үшінші тұлғалардың жеке деректерін рұқсатсыз жүктемеуге;</li>
  <li>сервисті қолданыстағы заңнамаға қайшы мақсаттарда пайдаланбауға;</li>
  <li>жүйеге немесе байланысты инфрақұрылымға зиян тигізбеуге.</li>
</ul>
<p>3.3. Тапсырыс беруші жүктейтін кез келген мазмұнға толықтай өзі жауапты.</p>

<h2>4. Жазылым және тарифтер</h2>
<p>4.1. Сервис ай сайынғы жазылым негізінде жұмыс істейді. Тарифтер:</p>
<ul>
  <li><strong>Мини — ₸9 900/ай:</strong> айына ~150 генерация (~50 тұтынушы);</li>
  <li><strong>Стандарт — ₸14 900/ай:</strong> айына ~300 генерация (~100 тұтынушы);</li>
  <li><strong>Бизнес — ₸24 900/ай:</strong> айына ~600 генерация (~200 тұтынушы);</li>
  <li><strong>Желі — ₸44 900/ай:</strong> айына ~1 200 генерация (~400 тұтынушы).</li>
</ul>
<p>4.2. Жеке бот (+₸25 000) — бір реттік баптау төлемі, ай сайынғы жазылымға қосымша.</p>
<p>4.3. Лимиттер жазылым мерзімі басталған сәттен бастап есептеледі және ай сайын жаңартылады.</p>
<p>4.4. Оператор тарифтерді өзгерту құқығын өзіне қалдырады. Өзгерістер 30 күн бұрын хабарланады.</p>

<h2>5. Төлем</h2>
<p>5.1. Төлем Kaspi Pay немесе Оператор ұсынған басқа тәсілдер арқылы жүзеге асырылады.</p>
<p>5.2. Жазылым автоматты түрде жаңартылмайды — Тапсырыс беруші ай сайын өз бетімен төлем жасайды.</p>
<p>5.3. Төлем сәтті өткеннен кейін сервис автоматты түрде іске қосылады.</p>

<h2>6. Офертаны қабылдау (акцепт)</h2>
<div class="highlight">
  <p>Кез келген тарифті немесе қызметті төлеу осы Офертаның барлық шарттарын толық және шартсыз қабылдау болып табылады. Акцепт кейін жазбаша растауды талап етпейді.</p>
</div>

<h2>7. Қайтару</h2>
<p>7.1. Төленген жазылым мерзімі ішіндегі пайдаланылмаған генерациялар үшін ақша қайтарылмайды.</p>
<p>7.2. Егер сервис Оператордың кінәсінен 72 сағаттан артық қол жетімсіз болса, Тапсырыс беруші жазылым мерзімін ұзартуды немесе пропорционалды қайтаруды талап ете алады.</p>
<p>7.3. Қайтару сұранысы қолдау қызметіне жазбаша түрде жіберіледі.</p>

<h2>8. Жауапкершілік</h2>
<p>8.1. Оператор сервистің үздіксіз жұмысын қамтамасыз етуге тырысады, бірақ техникалық үзілістерге 100% кепілдік бермейді.</p>
<p>8.2. Оператор үшінші тараптардың AI API қызметтерінің (fal.ai) жұмысына жауапты емес.</p>
<p>8.3. Тапсырыс беруші жүктеген суреттердің заңдылығы үшін толық жауапты.</p>

<h2>9. Дербес деректер</h2>
<p>9.1. Оператор жинайтын деректер:</p>
<ul>
  <li>Telegram ID және пайдаланушы аты;</li>
  <li>телефон нөмірі (егер ұсынылса);</li>
  <li>жазылым деректері мен генерация санауышы.</li>
</ul>
<p>9.2. Фотографиялар сақталмайды — AI өңдеуден кейін суреттер жойылады.</p>
<p>9.3. Деректер үшінші тарапқа сатылмайды немесе жарнама мақсатында пайдаланылмайды.</p>
<p>9.4. Тапсырыс беруші өз деректерін жою туралы сұраныс жіберуге құқылы.</p>

<h2>10. AI арқылы суреттерді өңдеу</h2>
<p>10.1. Генерация fal.ai сыртқы API арқылы жүзеге асырылады. Суреттер уақытша өңделіп жойылады.</p>
<p>10.2. AI нәтижелерінің дәлдігіне кепілдік берілмейді — нәтиже технологиялық шектеулерге байланысты өзгеруі мүмкін.</p>
<p>10.3. Тапсырыс беруші жүктейтін суреттерде бейнеленген адамдар осы өңдеуге келісімін берген болуы тиіс.</p>

<h2>11. Жауапкершілікті шектеу</h2>
<p>11.1. Оператор жанама залалдар үшін, соның ішінде жіберілген пайда, беделдің жоғалуы немесе деректер жоғалтуы үшін жауапты емес.</p>
<p>11.2. Барлық жағдайда Оператордың жауапкершілігі соңғы 1 айлық жазылым сомасынан аспайды.</p>

<h2>12. Блоктау</h2>
<p>12.1. Оператор ескертусіз мына жағдайларда аккаунтты блоктауға құқылы:</p>
<ul>
  <li>ережелерді бұзу;</li>
  <li>жалған немесе зиянды мазмұн жүктеу;</li>
  <li>кері инженерия немесе жүйені бұзу әрекеті;</li>
  <li>белсенді жазылымсыз жалғастырылған пайдалану.</li>
</ul>

<h2>13. Шарттарды өзгерту</h2>
<p>13.1. Оператор осы Офертаны кез келген уақытта өзгертуге құқылы.</p>
<p>13.2. Өзгерістер туралы хабарлама жазылымшыларға Telegram арқылы немесе сервис веб-сайтында жарияланады, күшіне ену күнінен 14 күн бұрын.</p>
<p>13.3. Өзгерістерден кейін сервисті пайдалануды жалғастыру жаңа шарттарды қабылдаған деп есептеледі.</p>

<h2>14. Байланыс және деректемелер</h2>
<div class="requisites">
  <p><strong>Оператор:</strong> ЖК [Тегі Аты Жөні]</p>
  <p><strong>БСН/ЖСН:</strong> __________________</p>
  <p><strong>Тіркелген мекен-жайы:</strong> Қазақстан Республикасы, __________________</p>
  <p><strong>E-mail:</strong> tamerlan.yeleuov@gmail.com</p>
  <p><strong>Telegram қолдауы:</strong> https://t.me/BeautyAI_Support</p>
  <p><strong>Жаңартылған күні:</strong> 2026 жылғы 26 мамыр</p>
</div>

</div>
<!-- /lang-block KZ -->


<!-- ═══════════════════════════════════════════════════
     РУССКАЯ ВЕРСИЯ
══════════════════════════════════════════════════════ -->
<div class="page-break"></div>
<div class="lang-block">

<div class="brand">Beauty <span>AI</span></div>
<div class="doc-title">ПУБЛИЧНАЯ ОФЕРТА</div>
<div class="doc-meta">
  О предоставлении доступа к сервису AI-генерации изображений через Telegram-бот<br>
  Редакция: 26 мая 2026 г. &nbsp;|&nbsp; Версия 1.0
</div>

<h2>1. Общие положения</h2>
<p>1.1. Настоящий документ является публичной офертой (далее — «Оферта») в соответствии с гражданским законодательством Республики Казахстан.</p>
<p>1.2. Оферту предлагает оператор сервиса Beauty AI (далее — «Оператор»), зарегистрированный в качестве индивидуального предпринимателя.</p>
<p>1.3. Оферта адресована любому физическому или юридическому лицу (далее — «Заказчик»), получающему доступ к сервису через Telegram или официальный сайт.</p>
<p>1.4. Полным и безоговорочным принятием (акцептом) всех условий Оферты является совершение Заказчиком оплаты любого тарифного плана или активация сервиса.</p>

<h2>2. Предмет оферты</h2>
<p>2.1. Оператор предоставляет Заказчику доступ к платформе Beauty AI SaaS — автоматизированному сервису подписки, работающему через Telegram-бот и использующему технологию искусственного интеллекта для обработки фотографий клиентов.</p>
<p>2.2. Основные функции сервиса:</p>
<ul>
  <li>генерация AI-изображений на основе селфи клиентов;</li>
  <li>настройка и управление Telegram-ботом для торговой точки;</li>
  <li>установка лимитов генерации в рамках тарифного плана;</li>
  <li>рассылка сообщений по клиентской базе торговой точки;</li>
  <li>доступ к статистике и административной панели (admin panel).</li>
</ul>

<h2>3. Использование сервиса</h2>
<p>3.1. Доступ к сервису предоставляется только по приглашению или через официальный B2B-канал.</p>
<p>3.2. Заказчик обязуется:</p>
<ul>
  <li>не предоставлять недостоверные данные;</li>
  <li>не загружать персональные данные третьих лиц без их согласия;</li>
  <li>не использовать сервис в целях, противоречащих действующему законодательству;</li>
  <li>не наносить вред системе или связанной инфраструктуре.</li>
</ul>
<p>3.3. Заказчик несёт полную ответственность за любой контент, загружаемый через сервис.</p>

<h2>4. Подписка и тарифы</h2>
<p>4.1. Сервис работает на основе ежемесячной подписки. Действующие тарифы:</p>
<ul>
  <li><strong>Мини — ₸9 900/мес:</strong> ~150 генераций в месяц (~50 клиентов);</li>
  <li><strong>Стандарт — ₸14 900/мес:</strong> ~300 генераций в месяц (~100 клиентов);</li>
  <li><strong>Бизнес — ₸24 900/мес:</strong> ~600 генераций в месяц (~200 клиентов);</li>
  <li><strong>Сеть — ₸44 900/мес:</strong> ~1 200 генераций в месяц (~400 клиентов).</li>
</ul>
<p>4.2. Подключение собственного бота (+₸25 000) — единовременный платёж за настройку, дополнительный к ежемесячной подписке.</p>
<p>4.3. Лимиты генераций отсчитываются с момента активации подписки и обновляются ежемесячно.</p>
<p>4.4. Оператор оставляет за собой право изменять тарифы с уведомлением за 30 дней.</p>

<h2>5. Оплата</h2>
<p>5.1. Оплата производится через Kaspi Pay или иные способы, предлагаемые Оператором.</p>
<p>5.2. Подписка не продлевается автоматически — Заказчик производит оплату самостоятельно каждый месяц.</p>
<p>5.3. После успешной оплаты сервис активируется автоматически.</p>

<h2>6. Акцепт оферты</h2>
<div class="highlight">
  <p>Оплата любого тарифного плана или услуги является полным и безоговорочным принятием всех условий настоящей Оферты. Акцепт не требует последующего письменного подтверждения.</p>
</div>

<h2>7. Возвраты</h2>
<p>7.1. Оплаченный период подписки возврату не подлежит за неиспользованные генерации.</p>
<p>7.2. Если сервис недоступен по вине Оператора более 72 часов подряд, Заказчик вправе запросить продление подписки или пропорциональный возврат средств.</p>
<p>7.3. Запрос на возврат направляется в службу поддержки в письменной форме.</p>

<h2>8. Ответственность</h2>
<p>8.1. Оператор прилагает усилия для обеспечения бесперебойной работы сервиса, однако не гарантирует 100% доступность.</p>
<p>8.2. Оператор не несёт ответственности за работу сторонних AI API (fal.ai).</p>
<p>8.3. Заказчик несёт полную ответственность за законность загружаемых изображений.</p>

<h2>9. Персональные данные</h2>
<p>9.1. Оператор собирает следующие данные:</p>
<ul>
  <li>Telegram ID и никнейм;</li>
  <li>номер телефона (при наличии);</li>
  <li>данные подписки и счётчик генераций.</li>
</ul>
<p>9.2. Фотографии не хранятся — изображения удаляются после AI-обработки.</p>
<p>9.3. Данные не продаются третьим лицам и не используются в рекламных целях.</p>
<p>9.4. Заказчик вправе направить запрос на удаление своих данных.</p>

<h2>10. AI-обработка изображений</h2>
<p>10.1. Генерация осуществляется через сторонний API fal.ai. Изображения временно обрабатываются и затем удаляются.</p>
<p>10.2. Точность результатов AI не гарантируется — результат может варьироваться в зависимости от технических ограничений.</p>
<p>10.3. Заказчик гарантирует, что лица, изображённые на загружаемых фото, дали согласие на подобную обработку.</p>

<h2>11. Ограничение ответственности</h2>
<p>11.1. Оператор не несёт ответственности за косвенные убытки, включая упущенную выгоду, репутационный ущерб или потерю данных.</p>
<p>11.2. В любом случае ответственность Оператора не превышает суммы оплаты за последний 1 месяц подписки.</p>

<h2>12. Блокировка</h2>
<p>12.1. Оператор вправе заблокировать аккаунт без предупреждения в случаях:</p>
<ul>
  <li>нарушения условий Оферты;</li>
  <li>загрузки незаконного или вредоносного контента;</li>
  <li>попытки обратной разработки или взлома системы;</li>
  <li>продолжения использования сервиса без активной подписки.</li>
</ul>

<h2>13. Изменение условий</h2>
<p>13.1. Оператор вправе изменять настоящую Оферту в любое время.</p>
<p>13.2. Уведомление об изменениях направляется подписчикам через Telegram или публикуется на сайте сервиса не менее чем за 14 дней до вступления в силу.</p>
<p>13.3. Продолжение использования сервиса после изменений считается принятием новых условий.</p>

<h2>14. Контакты и реквизиты</h2>
<div class="requisites">
  <p><strong>Оператор:</strong> ИП [Фамилия Имя Отчество]</p>
  <p><strong>БИН/ИИН:</strong> __________________</p>
  <p><strong>Юридический адрес:</strong> Республика Казахстан, __________________</p>
  <p><strong>E-mail:</strong> tamerlan.yeleuov@gmail.com</p>
  <p><strong>Telegram поддержка:</strong> https://t.me/BeautyAI_Support</p>
  <p><strong>Дата обновления:</strong> 26 мая 2026 г.</p>
</div>

</div>
<!-- /lang-block RU -->

</div><!-- /document -->
</body>
</html>
`;

// ─── Entry point ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Public oferta page (GET /oferta) ──
    if (request.method === 'GET' && url.pathname === '/oferta') {
      return new Response(OFERTA_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Beauty AI Bot Platform — OK', { status: 200 });
    }

    let update;
    try { update = await request.json(); }
    catch { return new Response('Bad Request', { status: 400 }); }

    // ── fal.ai async result callback ──
    if (url.pathname === '/fal-callback') {
      ctx.waitUntil(handleFalCallback(update, env));
      return new Response('OK');
    }

    // ── Admin panel bot ──
    if (url.pathname === '/admin-webhook') {
      ctx.waitUntil(handleAdminUpdate(update, env));
      return new Response('OK');
    }

    // ── Client salon bots ──
    // Capture everything after /webhook/ including colons in the bot token
    const match = url.pathname.match(/^\/webhook\/(.+)$/);
    if (!match) return new Response('OK');

    const botToken = decodeURIComponent(match[1]);

    // ── Standard tier: one shared bot, salon resolved by slug in deep-link ──
    if (env.STANDARD_BOT_TOKEN && botToken === env.STANDARD_BOT_TOKEN) {
      ctx.waitUntil(handleStandardUpdate(update, env));
      return new Response('OK');
    }

    // ── Premium tier: each salon has its own bot token ──
    const salon = await env.beauty_ai_db
      .prepare('SELECT * FROM salons WHERE bot_token = ?')
      .bind(botToken)
      .first();

    if (!salon) return new Response('OK');

    // Process in background so Telegram doesn't time-out the webhook
    ctx.waitUntil(handleUpdate(update, salon, env));
    return new Response('OK');
  },

  // Runs every minute via Cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollPendingJobs(env));           // every minute: deliver completed fal.ai jobs
    ctx.waitUntil(checkExpiredSubscriptions(env)); // daily: mark expired, notify owners
    ctx.waitUntil(resetMonthlyGenerations(env));   // 1st of month: reset monthly counters
    // Once per day at 10:00 UTC
    const h = new Date().getUTCHours();
    const m = new Date().getUTCMinutes();
    if (h === 10 && m < 2) {
      ctx.waitUntil(checkFalBudget(env));
      ctx.waitUntil(checkExpiringSubscriptions(env));
    }
  },
};

// ─── Cron: poll fal.ai for all pending jobs ───────────────────────────────────
async function pollPendingJobs(env) {
  const { results: jobs } = await env.beauty_ai_db
    .prepare(`SELECT * FROM pending_jobs
              WHERE status_url IS NOT NULL
              AND created_at > datetime('now', '-15 minutes')`)
    .all();

  console.log(`[cron] checking ${jobs.length} pending job(s)`);

  for (const job of jobs) {
    try {
      const statusRes = await fetch(job.status_url, {
        headers: { 'Authorization': `Key ${env.FAL_KEY}` },
      });
      const status = await statusRes.json();
      console.log(`[cron] job ${job.request_id} status: ${status.status}`);

      if (status.status === 'COMPLETED') {
        const resultRes = await fetch(job.response_url, {
          headers: { 'Authorization': `Key ${env.FAL_KEY}` },
        });
        const result = await resultRes.json();
        // Handle different model response shapes
        const imageUrl = result.image?.url
          ?? result.images?.[0]?.url
          ?? result.output?.image?.url
          ?? result.output?.images?.[0]?.url;

        console.log('[cron] result keys:', Object.keys(result).join(', '));
        if (imageUrl) {
          await deliverFalResult(job, imageUrl, env);
        } else {
          console.error('[cron] no image URL:', JSON.stringify(result).slice(0, 400));
        }
        await env.beauty_ai_db
          .prepare('DELETE FROM pending_jobs WHERE request_id = ?')
          .bind(job.request_id).run();

      } else if (status.status === 'FAILED') {
        console.error('[cron] job failed:', JSON.stringify(status).slice(0, 300));
        await notifyJobError(job, env);
        await env.beauty_ai_db
          .prepare('DELETE FROM pending_jobs WHERE request_id = ?')
          .bind(job.request_id).run();
      }
      // IN_QUEUE / IN_PROGRESS — leave for next poll
    } catch (err) {
      console.error(`[cron] error polling ${job.request_id}:`, err.message);
    }
  }
}

// ─── Daily: mark expired subscriptions, notify owners ────────────────────────
async function checkExpiredSubscriptions(env) {
  const { results: lapsed } = await env.beauty_ai_db
    .prepare(`
      SELECT * FROM salons
      WHERE paid_until IS NOT NULL
        AND paid_until < date('now')
        AND status IN ('standard_active', 'premium_active')
    `)
    .all();

  for (const salon of lapsed) {
    await env.beauty_ai_db
      .prepare("UPDATE salons SET status = 'expired' WHERE id = ?")
      .bind(salon.id).run();

    const name = salon.name || salon.salon_name || 'Ваш салон';
    await sendMessage(salon.bot_token, salon.admin_chat_id,
      `⚠️ *Подписка истекла — бот приостановлен!*\n\n` +
      `Работа ИИ-ассистента *${name}* остановлена.\n` +
      `Клиенты не могут примерять образы.\n\n` +
      `Продлите подписку для возобновления работы:`,
      tariffKeyboard()
    );
    console.log(`[cron] expired salon ${salon.id} (${name}), paid_until=${salon.paid_until}`);
  }
}

// ─── Daily: warn owners 3 days before subscription expires ───────────────────
async function checkExpiringSubscriptions(env) {
  const in3days = new Date();
  in3days.setUTCDate(in3days.getUTCDate() + 3);
  const targetDate = in3days.toISOString().slice(0, 10);

  const { results: salons } = await env.beauty_ai_db
    .prepare(`SELECT * FROM salons WHERE paid_until = ? AND status IN ('standard_active','premium_active')`)
    .bind(targetDate).all();

  for (const salon of salons) {
    const name     = salon.name || salon.salon_name || 'Ваш салон';
    const tgToken  = isValidTgToken(salon.bot_token) ? salon.bot_token : env.STANDARD_BOT_TOKEN;
    if (!tgToken || !salon.admin_chat_id) continue;
    await sendMessage(tgToken, salon.admin_chat_id,
      `⏰ *Подписка истекает через 3 дня!*\n\n` +
      `Тариф *${name}* заканчивается *${salon.paid_until}*.\n\n` +
      `Продлите сейчас — клиенты не потеряют доступ к ИИ-примерке:`,
      tariffKeyboard()
    );
    console.log(`[cron] expiry warning sent for salon ${salon.id} (paid_until=${salon.paid_until})`);
  }
}

// ─── 1st of month: reset monthly generation counters ─────────────────────────
async function resetMonthlyGenerations(env) {
  const { results: due } = await env.beauty_ai_db
    .prepare(`
      SELECT * FROM salons
      WHERE plan_reset_at IS NOT NULL
        AND plan_reset_at <= date('now')
        AND status IN ('standard_active', 'premium_active', 'trial')
    `)
    .all();

  for (const salon of due) {
    const nextReset = new Date(salon.plan_reset_at);
    nextReset.setUTCMonth(nextReset.getUTCMonth() + 1);
    const nextResetStr = nextReset.toISOString().slice(0, 10);

    await env.beauty_ai_db
      .prepare(`UPDATE salons
                SET monthly_generations_count = 0,
                    plan_used = 0,
                    plan_reset_at = ?
                WHERE id = ?`)
      .bind(nextResetStr, salon.id).run();

    const name = salon.name || salon.salon_name || 'Ваш салон';
    const max  = salon.max_allowed_generations || salon.plan_limit || 0;
    await sendMessage(salon.bot_token, salon.admin_chat_id,
      `🔄 *Новый месяц — лимит генераций сброшен!*\n\n` +
      `*${name}*: доступно *${max}* генераций.\n\n` +
      `Хотите продлить или сменить тариф? Нажмите кнопку *📋 Тариф*`
    );
    console.log(`[cron] reset monthly count for salon ${salon.id}, next reset: ${nextResetStr}`);
  }
}

// ─── Daily: check estimated fal.ai spend and alert if over threshold ─────────
async function checkFalBudget(env) {
  const row = await env.beauty_ai_db
    .prepare(`SELECT SUM(monthly_generations_count) AS total_gens FROM salons
              WHERE status IN ('standard_active','premium_active','trial')`)
    .first();

  const totalGens  = row?.total_gens ?? 0;
  const spentUsd   = totalGens * 0.04;
  const threshold  = parseFloat(env.FAL_ALERT_THRESHOLD_USD ?? '20');

  console.log(`[fal-budget] ~$${spentUsd.toFixed(2)} spent this month (${totalGens} gens), threshold $${threshold}`);

  if (spentUsd < threshold) return;

  const adminToken = env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN;
  if (!env.ADMIN_USER_ID || !adminToken) return;

  // Build per-salon breakdown (top spenders)
  const { results: salons } = await env.beauty_ai_db
    .prepare(`SELECT salon_name, monthly_generations_count
              FROM salons
              WHERE monthly_generations_count > 0
              ORDER BY monthly_generations_count DESC
              LIMIT 10`)
    .all();

  let breakdown = '';
  for (const s of salons) {
    const cost = (s.monthly_generations_count * 0.04).toFixed(2);
    breakdown += `• ${s.salon_name}: ${s.monthly_generations_count} ген. (~$${cost})\n`;
  }

  await sendMessage(adminToken, String(env.ADMIN_USER_ID),
    `⚠️ *Расходы fal.ai превысили порог $${threshold}*\n\n` +
    `Этот месяц потрачено: *~$${spentUsd.toFixed(2)}* (${totalGens} генераций)\n\n` +
    `📊 *Топ салонов по расходам:*\n${breakdown}\n` +
    `👉 Пополни баланс на [fal.ai/settings/billing](https://fal.ai/settings/billing)\n\n` +
    `_Порог можно изменить через переменную FAL\\_ALERT\\_THRESHOLD\\_USD_`
  );
}

// Deletes generated files from fal.ai CDN storage immediately after delivery
async function deleteFalPayload(requestId, falKey) {
  const url = `https://api.fal.ai/v1/models/requests/${requestId}/payloads`;
  try {
    const res = await fetch(url, {
      method : 'DELETE',
      headers: { 'Authorization': `Key ${falKey}` },
    });
    const body = await res.text();
    if (res.ok) {
      console.log(`[privacy] deleted payload ${requestId}:`, body);
    } else {
      console.warn(`[privacy] delete failed ${res.status} for ${requestId}:`, body);
    }
  } catch (err) {
    console.warn('[privacy] delete error:', err.message);
  }
}

async function deliverFalResult(job, imageUrl, env) {
  // For Standard-tier: look up by salon_id (FK); Premium: fall back to bot_token
  const salon = job.salon_id
    ? await env.beauty_ai_db.prepare('SELECT * FROM salons WHERE id = ?').bind(job.salon_id).first()
    : await env.beauty_ai_db.prepare('SELECT * FROM salons WHERE bot_token = ?').bind(job.bot_token).first();

  const user = await env.beauty_ai_db
    .prepare('SELECT * FROM users WHERE user_id = ? AND bot_token = ?')
    .bind(job.user_id, job.bot_token).first();

  if (!salon || !user) return;

  // Standard-tier salons have a synthetic bot_token — use the real Telegram token
  const tgToken = isValidTgToken(salon.bot_token) ? salon.bot_token : env.STANDARD_BOT_TOKEN;

  const resultLine  = {
    barber: '🎉 Вот ваша новая причёска!',
    makeup: '🎉 Вот ваш новый образ!',
    nails : '🎉 Вот ваш новый маникюр!',
  };
  const retryTexts  = {
    barber : `✂️ Хотите примерить другую причёску? Пришлите новое *СЕЛФИ*!`,
    makeup : `💄 Хотите примерить другой образ? Пришлите новое *ФОТО*!`,
    nails  : `💅 Хотите попробовать другой дизайн? Пришлите новое *ФОТО рук*!`,
  };
  const retryStates = { barber: S.WAITING_SELFIE, makeup: S.WAITING_FACE, nails: S.WAITING_HAND };

  const salonTitle  = salon.name || salon.salon_name || 'салон';
  const discCaption = salon.discount
    ? `💡 Нравится? Запишись в *${salonTitle}* со скидкой ${salon.discount}%!`
    : `💡 Нравится? Запишись в *${salonTitle}*!`;
  await sendPhotoFile(tgToken, job.chat_id, imageUrl,
    `${resultLine[salon.salon_type] ?? '🎉 Готово!'}\n\n${discCaption}`,
    env.FAL_KEY
  );

  await deleteFalPayload(job.request_id, env.FAL_KEY);

  await incrementAndCheckLimit(
    env, tgToken, job.chat_id, salon, user, job.user_id, salon.max_images,
    retryTexts[salon.salon_type]  ?? '🔄 Попробуй ещё раз!',
    retryStates[salon.salon_type] ?? S.WAITING_SELFIE
  );
}

async function notifyJobError(job, env) {
  const salon = await env.beauty_ai_db
    .prepare('SELECT salon_type FROM salons WHERE bot_token = ?')
    .bind(job.bot_token).first();
  await sendMessage(job.bot_token, job.chat_id,
    '❌ ИИ не смог обработать фото. Попробуй с другим — более чётким, при хорошем освещении.'
  );
  const resetState = { barber: S.WAITING_SELFIE, makeup: S.WAITING_FACE, nails: S.WAITING_HAND };
  await setState(env, job.user_id, job.bot_token, resetState[salon?.salon_type] ?? S.WAITING_SELFIE, {});
}

// ─── Slug / token helpers ─────────────────────────────────────────────────────

// Real Telegram bot tokens look like "1234567890:AAHxx..."
function isValidTgToken(token) {
  return /^\d+:[A-Za-z0-9_-]{35,}$/.test(token ?? '');
}

// ─── Multi-admin support ──────────────────────────────────────────────────────
// Primary admin(s) come from ADMIN_USER_ID (comma-separated).
// Extra admins can be added/removed via the panel and are stored in the admins table.
function getPrimaryAdminIds(env) {
  if (!env.ADMIN_USER_ID) return [];
  return String(env.ADMIN_USER_ID).split(',').map(s => s.trim()).filter(Boolean);
}

async function isAdminId(env, userId) {
  if (getPrimaryAdminIds(env).includes(String(userId))) return true;
  const row = await env.beauty_ai_db
    .prepare('SELECT 1 FROM admins WHERE user_id = ?')
    .bind(String(userId)).first();
  return !!row;
}

// Generates a URL-safe slug from a salon name + 4-char random suffix.
function generateSlug(name) {
  const base = (name || 'salon')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 12)
    .replace(/_+$/, '') || 'salon';
  const hash = Math.random().toString(36).slice(2, 6);
  return `${base}_${hash}`;
}

// ─── Subscription helpers ─────────────────────────────────────────────────────

// Trial salons (no paid_until) are never expired — they run until limit is hit.
function isSubscriptionExpired(salon) {
  if (salon.status === 'expired') return true;
  if (!salon.paid_until) return false;
  return new Date().toISOString().slice(0, 10) > salon.paid_until;
}

// Returns true if the salon-level monthly generation cap is exhausted.
function isMonthlyLimitReached(salon) {
  const max  = salon.max_allowed_generations ?? salon.plan_limit  ?? 0;
  const used = salon.monthly_generations_count ?? salon.plan_used ?? 0;
  return max > 0 && used >= max;
}

// Tariff selection keyboard — reused in multiple flows.
function ownerMenuKeyboard() {
  return {
    keyboard: [
      ['📋 Тариф', '📢 Рассылка'],
      ['📷 QR-код клиентам', '⚙️ Настройки'],
      ['📊 Статистика', '💬 Поддержка'],
    ],
    resize_keyboard: true,
    persistent: true,
  };
}

async function showOwnerPanel(botToken, chatId, salon) {
  const used  = salon.monthly_generations_count ?? salon.plan_used  ?? 0;
  const limit = salon.max_allowed_generations   ?? salon.plan_limit ?? 0;
  const name  = salon.plan_name ?? salon.status ?? '—';
  await sendMessage(botToken, chatId,
    `👤 *${salon.name ?? salon.salon_name}* — панель владельца\n\n` +
    `📊 Тариф: *${name}* · ${used}/${limit} генераций`,
    ownerMenuKeyboard()
  );
}

async function sendQrCode(botToken, chatId, url) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(url)}`;
  const resp  = await fetch(qrUrl);
  if (!resp.ok) {
    await sendMessage(botToken, chatId,
      `🔗 *Ссылка для клиентов:*\n${url}\n\n_QR-сервис временно недоступен_`
    );
    return;
  }
  const buf  = await resp.arrayBuffer();
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', new Blob([buf], { type: 'image/png' }), 'qr.png');
  form.append('caption',
    `📷 *QR-код для клиентов*\n\n` +
    `Распечатай и поставь на стойку, добавь в Instagram или WhatsApp.\n\n` +
    `🔗 Ссылка: \`${url}\``
  );
  form.append('parse_mode', 'Markdown');
  await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, { method: 'POST', body: form });
}

// prefix determines which callback handler receives the tap (b2b_type | trial_type | sedit_type)
function salonTypeKeyboard(prefix) {
  return { inline_keyboard: [
    [{ text: '✂️ Барбершоп / Стрижки',     callback_data: `${prefix}_barber` }],
    [{ text: '💄 Макияж / Студия красоты', callback_data: `${prefix}_makeup` }],
    [{ text: '💅 Ногти / Маникюр',          callback_data: `${prefix}_nails`  }],
  ]};
}

function tariffKeyboard() {
  return { inline_keyboard: [
    [{ text: '🟢 Старт · 150 ген. · ₸9,900',   callback_data: 'stariff_start' }],
    [{ text: '🔵 Базовый · 300 ген. · ₸14,900', callback_data: 'stariff_basic' }],
    [{ text: '🟣 Про · 600 ген. · ₸24,900',     callback_data: 'stariff_pro'   }],
    [{ text: '⭐ Макс · 1200 ген. · ₸39,900',   callback_data: 'stariff_max'   }],
  ]};
}

// ─── Main update dispatcher ───────────────────────────────────────────────────
async function handleUpdate(update, salon, env) {
  // Handle inline keyboard taps (hairstyle preset selection)
  if (update.callback_query) {
    await handleSalonCallback(update.callback_query, salon, env);
    return;
  }

  const message = update.message || update.edited_message;
  if (!message) return;

  const chatId    = String(message.chat.id);
  const userId    = String(message.from.id);
  const botToken  = salon.bot_token;

  // ── Ensure user row exists ──
  await env.beauty_ai_db
    .prepare(`
      INSERT OR IGNORE INTO users (user_id, bot_token, image_count)
      VALUES (?, ?, 0)
    `)
    .bind(userId, botToken)
    .run();

  const user = await env.beauty_ai_db
    .prepare('SELECT * FROM users WHERE user_id = ? AND bot_token = ?')
    .bind(userId, botToken)
    .first();

  // ── Load conversation state ──
  const stateRow  = await env.beauty_ai_db
    .prepare('SELECT * FROM user_states WHERE user_id = ? AND bot_token = ?')
    .bind(userId, botToken)
    .first();

  const state    = stateRow?.state    ?? 'start';
  const tempData = JSON.parse(stateRow?.temp_data ?? '{}');

  // ── Salon owner admin panel ──
  if (chatId === String(salon.admin_chat_id)) {

    // Receipt upload always goes through regardless of subscription status
    if (message.photo && state === S.SALON_TARIFF_RECEIPT) {
      await handleOwnerReceipt(message, salon, tempData, env, botToken, chatId, userId);
      return;
    }

    // Subscription expired — show warning + renewal buttons for every owner message
    if (isSubscriptionExpired(salon)) {
      await sendMessage(botToken, chatId,
        `⚠️ *Ваша подписка истекла!*\n\n` +
        `Работа вашего ИИ-ассистента приостановлена.\n` +
        `Клиенты не могут примерять образы.\n\n` +
        `Продлите подписку на следующий месяц для возобновления работы:`,
        tariffKeyboard()
      );
      return;
    }

    // No subscription yet (fresh, non-trial) — prompt to activate
    // Trial salons skip this: the owner goes through as a client for the test-drive
    if (!salon.plan_name && !salon.paid_until && salon.status !== 'trial') {
      await sendMessage(botToken, chatId,
        '🔒 *Нет активной подписки*\n\nВыберите тариф чтобы активировать бота:\n\n' +
        '🟢 Старт — 150 ген./мес — ₸9,900\n' +
        '🔵 Базовый — 300 ген./мес — ₸14,900\n' +
        '🟣 Про — 600 ген./мес — ₸24,900\n' +
        '⭐ Макс — 1200 ген./мес — ₸39,900',
        tariffKeyboard()
      );
      return;
    }

    // Active subscription only — handle owner commands / buttons
    // Trial owners fall through here and continue as clients (test-drive)
    if (salon.status !== 'trial') {
      if (message.text === '/tariff' || message.text === '📋 Тариф') {
        const used  = salon.monthly_generations_count ?? salon.plan_used  ?? 0;
        const limit = salon.max_allowed_generations   ?? salon.plan_limit ?? 0;
        const name  = salon.plan_name ?? salon.status ?? '—';
        await sendMessage(botToken, chatId,
          `📋 Тариф: *${name}* · использовано *${used}/${limit}* ген.\n\nВыберите тариф для продления:`,
          tariffKeyboard()
        );
        return;
      }

      if (message.text === '/push' || message.text === '📢 Рассылка') {
        await setState(env, userId, botToken, S.SALON_PUSH_TEXT, {});
        await sendMessage(botToken, chatId,
          '📢 *Рассылка клиентам*\n\nНапиши текст сообщения которое получат все клиенты:',
          { remove_keyboard: true }
        );
        return;
      }

      if (message.text === '/qr' || message.text === '📷 QR-код клиентам') {
        const botUsername = env.STANDARD_BOT_USERNAME ?? 'qrbeatyai_bot';
        const slug = salon.slug;
        if (!slug) {
          await sendMessage(botToken, chatId, '❌ У вашего салона нет ссылки для клиентов.');
          return;
        }
        await sendQrCode(botToken, chatId, `https://t.me/${botUsername}?start=${slug}`);
        return;
      }

      if (message.text === '/settings' || message.text === '⚙️ Настройки') {
        const curMax = salon.max_images ?? 3;
        await sendMessage(botToken, chatId, '⚙️ *Настройки салона*\n\nЧто изменить?', {
          inline_keyboard: [
            [{ text: '✏️ Название',                       callback_data: 'sedit_name'  }],
            [{ text: '📱 WhatsApp',                       callback_data: 'sedit_phone' }],
            [{ text: '🏷️ Тип салона',                    callback_data: 'sedit_type'  }],
            [{ text: `🎯 Примерок на клиента: ${curMax}`, callback_data: 'sedit_max'   }],
          ],
        });
        return;
      }

      if (message.text === '/stats' || message.text === '📊 Статистика') {
        const [totalRow, activeRow] = await Promise.all([
          env.beauty_ai_db.prepare('SELECT COUNT(DISTINCT user_id) AS cnt FROM users WHERE salon_id = ?').bind(salon.id).first(),
          env.beauty_ai_db.prepare('SELECT COUNT(DISTINCT user_id) AS cnt FROM users WHERE salon_id = ? AND image_count > 0').bind(salon.id).first(),
        ]);
        const used   = salon.monthly_generations_count ?? 0;
        const limit  = salon.max_allowed_generations ?? 0;
        const maxImg = salon.max_images ?? 3;
        const paidLine = salon.paid_until ? `\n📅 Подписка до: *${salon.paid_until}*` : '';
        await sendMessage(botToken, chatId,
          `📊 *Статистика — ${salon.name ?? salon.salon_name}*\n\n` +
          `👥 Всего клиентов: *${totalRow?.cnt ?? 0}*\n` +
          `✅ Делали примерку: *${activeRow?.cnt ?? 0}*\n\n` +
          `🎨 Генераций этот месяц: *${used} / ${limit}*\n` +
          `🎯 Лимит примерок на клиента: *${maxImg}*` +
          paidLine
        );
        return;
      }

      if (message.text === '💬 Поддержка') {
        const supportLink = env.SUPPORT_TG_LINK ?? 'https://t.me/BeautyAI_Support';
        await sendMessage(botToken, chatId,
          `💬 *Поддержка Beauty AI*\n\nЕсли возникли вопросы по тарифу, боту или оплате — напишите нам:\n\n👉 ${supportLink}`
        );
        return;
      }

      if ([S.SALON_PUSH_TEXT, S.SALON_PUSH_BUTTONS, S.SALON_PUSH_CONFIRM].includes(state)) {
        await handleSalonPushMessage(message, salon, tempData, env, botToken, chatId, userId);
        return;
      }

      if ([S.SALON_EDIT_NAME, S.SALON_EDIT_PHONE].includes(state)) {
        await handleSalonEdit(message, salon, state, env, botToken, chatId, userId);
        return;
      }

      // Any other message → show owner panel menu
      await showOwnerPanel(botToken, chatId, salon);
      return;
    }

    // Trial owner who has finished the test-drive — show tariff selector
    if (state === S.DONE) {
      await showB2bTariffSelector(botToken, chatId, env);
      return;
    }
    // Trial: owner continues below as a regular client
  }

  // ── Block clients: subscription expired ──
  if (isSubscriptionExpired(salon)) {
    if (message.text === '/start') {
      await sendMessage(botToken, chatId,
        '⏸ Извините, в данный момент сервис в этом салоне временно недоступен. ' +
        'Пожалуйста, обратитесь к администратору салона.'
      );
    }
    return;
  }

  // ── Block clients: monthly limit exhausted ──
  if (isMonthlyLimitReached(salon)) {
    if (message.text === '/start') {
      await sendMessage(botToken, chatId,
        '⏸ Извините, на этот месяц лимит бесплатных примерок в данном салоне исчерпан. ' +
        'Сервис возобновит работу в начале следующего месяца.'
      );
    }
    return;
  }

  // ── Route the message ──

  if (message.text === '/start') {
    const maxImages = salon.max_images ?? 3;
    // At limit — show CTA or tariff selector for trial owners
    if ((user.image_count ?? 0) >= maxImages) {
      if (salon.status === 'trial' && String(chatId) === String(salon.admin_chat_id)) {
        await showB2bTariffSelector(botToken, chatId, env);
      } else {
        await sendOfferMessage(botToken, chatId, salon);
      }
      return;
    }
    // Already processing — don't interrupt
    if (state === S.PROCESSING) {
      await sendMessage(botToken, chatId,
        '⏳ Ваш результат уже генерируется! Пришлю как только будет готово — подождите.'
      );
      return;
    }
    if (user?.phone) {
      // Returning user — skip contact step, go straight to photo
      const remaining = maxImages - (user.image_count ?? 0);
      const hints = {
        barber: '📸 Пришлите *СЕЛФИ* своего лица, подберём новую причёску!',
        makeup: '📸 Пришлите *ФОТО лица*, подберём образ!',
        nails:  '📸 Пришлите *ФОТО рук* ладонями вверх, подберём маникюр!',
      };
      await sendMessage(botToken, chatId,
        `👋 С возвращением! Осталось примерок: *${remaining}*.\n\n${hints[salon.salon_type] ?? hints.barber}`,
        { remove_keyboard: true }
      );
      const photoStates = { barber: S.WAITING_SELFIE, makeup: S.WAITING_FACE, nails: S.WAITING_HAND };
      await setState(env, userId, botToken, photoStates[salon.salon_type] ?? S.WAITING_SELFIE, {});
    } else {
      await onStart(message, salon, botToken, chatId, env);
      await setState(env, userId, botToken, S.WAITING_CONTACT, {});
    }
    return;
  }

  if (message.contact) {
    await onContact(message, salon, user, env, botToken, chatId, userId);
    return;
  }

  if (message.photo) {
    await onPhoto(message, salon, user, state, tempData, env, botToken, chatId, userId);
    return;
  }

  // Prompt user if they send text while we're waiting for a photo or contact
  if (state === S.WAITING_CONTACT) {
    await sendMessage(botToken, chatId,
      '👆 Нажмите кнопку ниже, чтобы поделиться номером телефона.',
      contactKeyboard()
    );
  } else if (state === S.WAITING_COLOR) {
    await sendMessage(botToken, chatId, '🎨 Выберите цвет волос:', colorKeyboard());
  } else if (state === S.WAITING_STYLE_CHOICE) {
    const td = tempData;
    if (!td.gender) {
      await sendMessage(botToken, chatId, '👤 Для кого подбираем причёску?', genderKeyboard());
    } else {
      const kb = td.gender === 'male' ? maleStylesKeyboard() : femaleStylesKeyboard();
      await sendMessage(botToken, chatId, '💇 Выберите *стиль причёски*:', kb);
    }
  } else if ([S.WAITING_SELFIE, S.WAITING_FACE, S.WAITING_HAND].includes(state)) {
    await sendMessage(botToken, chatId, '📸 Пришлите фотографию, пожалуйста.');
  } else if (state === S.PROCESSING) {
    await sendMessage(botToken, chatId,
      '⏳ Ваш результат уже генерируется! Пришлю, как только будет готово — обычно 30–60 секунд.'
    );
  } else if (state === S.DONE) {
    // User finished all free tries — push them to the booking CTA
    await sendOfferMessage(botToken, chatId, salon);
  } else {
    // Unknown state or 'start' — redirect to /start, no conversation
    const hints = {
      barber: '✂️ Нажмите /start чтобы примерить причёску!',
      makeup: '💄 Нажмите /start чтобы примерить макияж!',
      nails:  '💅 Нажмите /start чтобы примерить маникюр!',
    };
    await sendMessage(botToken, chatId, hints[salon.salon_type] ?? '👋 Нажмите /start чтобы начать!');
  }
}

// ─── Standard tier routing ────────────────────────────────────────────────────
// One shared bot (STANDARD_BOT_TOKEN) serves all Standard-plan and trial salons.
//
// Routing priority:
//   1. User is in B2B onboarding (state = b2b_name / b2b_phone) → onboarding handler
//   2. Sender is a known owner (admin_chat_id in salons) → owner admin panel
//   3. /start b2b_<source>  → start B2B test-drive flow
//   4. /start <slug>        → associate user with salon, set admin_chat_id if unclaimed
//   5. /start (no slug)     → resume if already associated
//   6. Any other message    → route via stored salon_id
async function handleStandardUpdate(update, env) {
  const botToken = env.STANDARD_BOT_TOKEN ?? env.ADMIN_BOT_TOKEN;

  // ── Platform admin: route to admin panel ─────────────────────────────────
  const senderId = String(
    (update.message ?? update.edited_message ?? update.callback_query)?.from?.id ?? ''
  );
  if (await isAdminId(env, senderId)) {
    await handleAdminUpdate(update, env);
    return;
  }

  // ── Callback queries ──────────────────────────────────────────────────────
  if (update.callback_query) {
    const cq     = update.callback_query;
    const chatId = String(cq.message.chat.id);
    const userId = String(cq.from.id);

    // Send oferta PDF
    if (cq.data === 'show_oferta') {
      await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });
      const row = await env.beauty_ai_db
        .prepare("SELECT value FROM settings WHERE key = 'oferta_pdf'").first();
      if (row?.value) {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('document', row.value);
        form.append('caption', '📋 *Публичная оферта Beauty AI*\n_KZ / RU версии в одном документе_');
        form.append('parse_mode', 'Markdown');
        await fetch(`${TELEGRAM_API}/bot${botToken}/sendDocument`, { method: 'POST', body: form });
      } else {
        const workerUrl = env?.WORKER_URL ?? 'https://beauty-ai-saas.artbycube8.workers.dev';
        await sendMessage(botToken, chatId, `📋 [Публичная оферта](${workerUrl}/oferta)`);
      }
      return;
    }

    // Own-bot connection choice after payment
    if (cq.data === 'b2b_own_self' || cq.data === 'b2b_own_support') {
      await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });
      if (cq.data === 'b2b_own_self') {
        await sendMessage(botToken, chatId,
          `🔧 *Создание бота через BotFather:*\n\n` +
          `1. Откройте @BotFather в Telegram\n` +
          `2. Отправьте /newbot\n` +
          `3. Введите название (например: _Барбершоп Алмас_)\n` +
          `4. Введите username — только латиница и заканчивается на \`_bot\`\n   _(например: almas\\_barber\\_bot)_\n` +
          `5. Скопируйте API Token и пришлите его сюда 👇`
        );
      } else {
        const supportLink = env.SUPPORT_TG_LINK ?? 'https://t.me/your_support';
        await setState(env, userId, botToken, 'start', {});
        await sendMessage(botToken, chatId,
          `💬 *Подключение через поддержку*\n\n` +
          `Наш специалист поможет вам подключить бота — просто напишите нам и мы всё сделаем за вас.\n\n` +
          `👉 [Написать в поддержку](${supportLink})\n\n` +
          `_Вам ответят как можно быстрее._`
        );
      }
      return;
    }

    // B2B type selection during onboarding
    if (cq.data?.startsWith('b2b_type_')) {
      await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });
      const typeRow = await env.beauty_ai_db
        .prepare('SELECT state, temp_data FROM user_states WHERE user_id = ? AND bot_token = ?')
        .bind(userId, botToken).first();
      if ((typeRow?.state ?? '') !== S.B2B_TYPE) return;
      const typeTmp = JSON.parse(typeRow?.temp_data ?? '{}');
      const salonType = cq.data.replace('b2b_type_', '');
      const typeNames = { barber: 'Барбершоп / Стрижки', makeup: 'Макияж / Студия красоты', nails: 'Ногти / Маникюр' };
      await setState(env, userId, botToken, S.B2B_PHONE, { ...typeTmp, salon_type: salonType });
      await sendMessage(botToken, chatId,
        `✅ Тип: *${typeNames[salonType] ?? salonType}*\n\n📱 Введите WhatsApp-номер салона (только цифры):\n_Например: 77001112233_`
      );
      return;
    }

    // B2B package/tariff selection callbacks
    if (cq.data?.startsWith('b2b_pkg_') || cq.data === 'b2b_hosting_own') {
      await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });
      await handleB2bPackageCallback(cq.data, botToken, chatId, userId, env);
      return;
    }

    // User clicked "Оплатить через Kaspi" after choosing a package
    if (cq.data?.startsWith('b2b_pay_')) {
      await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });
      const pkgKey = cq.data.replace('b2b_pay_', '');
      const pkg = B2B_PACKAGES[pkgKey];
      if (!pkg) return;
      await setState(env, userId, botToken, S.B2B_AWAITING_PHONE, {
        pkg_key: pkgKey, pkg_name: pkg.name, pkg_price: pkg.price, pkg_gens: pkg.gens, pkg_is_own: pkg.own,
      });
      await sendMessage(botToken, chatId,
        `📱 Введите номер телефона для выставления счета Kaspi:\n_Только цифры, например: 77001112233_`
      );
      return;
    }

    const ownerSalon = await findStandardOwnerSalon(env, chatId);
    if (ownerSalon) {
      await handleSalonCallback(cq, { ...ownerSalon, bot_token: botToken }, env);
      return;
    }
    const salon = await getStandardSalonForUser(env, userId, botToken);
    if (salon) await handleSalonCallback(cq, { ...salon, bot_token: botToken }, env);
    return;
  }

  const message = update.message || update.edited_message;
  if (!message) return;

  const userId = String(message.from.id);
  const chatId = String(message.chat.id);
  const text   = message.text ?? '';

  // ── B2B state check (before owner/client routing) ────────────────────────
  if (!text.startsWith('/start')) {
    const stateRow = await env.beauty_ai_db
      .prepare('SELECT state, temp_data FROM user_states WHERE user_id = ? AND bot_token = ?')
      .bind(userId, botToken).first();
    const curState   = stateRow?.state ?? 'start';
    const curTmpData = JSON.parse(stateRow?.temp_data ?? '{}');

    if (curState === S.B2B_NAME || curState === S.B2B_PHONE) {
      await handleB2bOnboarding(message, env, userId, chatId, botToken, curState, curTmpData);
      return;
    }
    if (curState === S.B2B_AWAITING_PHONE) {
      await handleB2bAwaitingPhone(message, env, userId, chatId, botToken, curTmpData);
      return;
    }
    if (curState === S.B2B_AWAITING_CHEQUE) {
      await handleB2bCheque(message, env, userId, chatId, botToken, curTmpData);
      return;
    }
    if (curState === S.B2B_CONFIRMATION_PENDING) {
      if (message.photo || message.document) {
        await sendMessage(botToken, chatId, '⏱ Ваш чек уже отправлен на проверку. Пожалуйста, ожидайте.');
      }
      return;
    }
    if (curState === S.B2B_AWAITING_TOKEN) {
      await handleB2bToken(message, env, userId, chatId, botToken, curTmpData);
      return;
    }
  }

  // ── Known salon owner ─────────────────────────────────────────────────────
  const ownerSalon = await findStandardOwnerSalon(env, chatId);
  if (ownerSalon) {
    await handleUpdate(update, { ...ownerSalon, bot_token: botToken }, env);
    return;
  }

  // ── /start handling ───────────────────────────────────────────────────────
  if (text.startsWith('/start')) {
    const slug = text.length > 6 ? text.slice(7).trim() : '';

    if (slug) {
      // B2B lead link: ?start=b2b_almaty, ?start=b2b_instagram, ?start=b2b_direct
      if (slug.startsWith('b2b_')) {
        await env.beauty_ai_db
          .prepare('INSERT OR IGNORE INTO users (user_id, bot_token, image_count) VALUES (?, ?, 0)')
          .bind(userId, botToken).run();
        await setState(env, userId, botToken, S.B2B_NAME, { source_track: slug });
        await sendMessage(botToken, chatId,
          `✂️ *Beauty AI — ИИ-примерка причёсок для вашего салона*\n\n` +
          `Ваши клиенты смогут примерить стрижку или маникюр прямо в Telegram — до записи к вам.\n\n` +
          `*Сейчас вы пройдёте через это сами — как ваш клиент.*\n` +
          `Займёт 3 минуты.\n\n` +
          `✍️ Как называется ваш салон?`
        );
        return;
      }

      // Pre-created trial or Standard salon
      const salon = await env.beauty_ai_db
        .prepare("SELECT * FROM salons WHERE slug = ? AND status IN ('standard_active','trial')")
        .bind(slug).first();

      if (!salon) {
        await sendMessage(botToken, chatId, '❌ Ссылка недействительна. Обратитесь к менеджеру.');
        return;
      }

      // Auto-attach admin_chat_id: first person to open the link becomes the owner
      // '0' is the sentinel for "unclaimed" (admin_chat_id is NOT NULL in DB)
      let activeSalon = salon;
      if (!salon.admin_chat_id || salon.admin_chat_id === '0') {
        await env.beauty_ai_db
          .prepare('UPDATE salons SET admin_chat_id = ? WHERE id = ?')
          .bind(userId, salon.id).run();
        activeSalon = { ...salon, admin_chat_id: userId };
        await sendWelcomePhotos(botToken, chatId, env);
        await sendMessage(botToken, chatId,
          `✅ *${salon.name || salon.salon_name}* — ваш аккаунт привязан!\n\n` +
          `Теперь этот бот знает вас как владельца. Начнём тест-драйв — пришлите *СЕЛФИ*:`
        );
        await setState(env, userId, botToken, S.WAITING_SELFIE, {});
        await env.beauty_ai_db
          .prepare('INSERT OR IGNORE INTO users (user_id, bot_token, salon_id, image_count) VALUES (?, ?, ?, 0)')
          .bind(userId, botToken, activeSalon.id).run();
        await env.beauty_ai_db
          .prepare('UPDATE users SET salon_id = ? WHERE user_id = ? AND bot_token = ?')
          .bind(activeSalon.id, userId, botToken).run();
        return;
      }

      // Client or returning owner — normal /start flow
      await env.beauty_ai_db
        .prepare('INSERT OR IGNORE INTO users (user_id, bot_token, salon_id, image_count) VALUES (?, ?, ?, 0)')
        .bind(userId, botToken, activeSalon.id).run();
      // Reset image_count if client moved to a different salon
      const existingUser = await env.beauty_ai_db
        .prepare('SELECT salon_id FROM users WHERE user_id = ? AND bot_token = ?')
        .bind(userId, botToken).first();
      if (existingUser && String(existingUser.salon_id) !== String(activeSalon.id)) {
        await env.beauty_ai_db
          .prepare('UPDATE users SET salon_id = ?, image_count = 0 WHERE user_id = ? AND bot_token = ?')
          .bind(activeSalon.id, userId, botToken).run();
      } else {
        await env.beauty_ai_db
          .prepare('UPDATE users SET salon_id = ? WHERE user_id = ? AND bot_token = ?')
          .bind(activeSalon.id, userId, botToken).run();
      }

      const startUpdate = { ...update, message: { ...message, text: '/start' } };
      await handleUpdate(startUpdate, { ...activeSalon, bot_token: botToken }, env);
      return;
    }

    // Plain /start with no slug
    const salon = await getStandardSalonForUser(env, userId, botToken);
    if (salon) {
      await handleUpdate(update, { ...salon, bot_token: botToken }, env);
    } else {
      await sendMessage(botToken, chatId, '👋 Перейди по ссылке от своего салона чтобы начать.');
    }
    return;
  }

  // ── Regular message — route via stored association ────────────────────────
  const salon = await getStandardSalonForUser(env, userId, botToken);
  if (!salon) {
    await sendMessage(botToken, chatId, '👋 Перейди по ссылке от своего салона чтобы начать.');
    return;
  }
  await handleUpdate(update, { ...salon, bot_token: botToken }, env);
}

// ─── Trial salon creation ─────────────────────────────────────────────────────

async function createTrialSalon(env, name, phone, sourceTrack = 'direct', adminChatId = null, salonType = 'barber') {
  let slug;
  for (let i = 0; i < 5; i++) {
    slug = generateSlug(name);
    const exists = await env.beauty_ai_db
      .prepare('SELECT id FROM salons WHERE slug = ?').bind(slug).first();
    if (!exists) break;
  }
  // Synthetic bot_token: not a real Telegram token, unique per Standard-tier salon
  const syntheticToken = 'trial:' + slug;

  await env.beauty_ai_db
    .prepare(`
      INSERT INTO salons
        (slug, bot_token, status, name, salon_name, salon_type,
         whatsapp_phone, admin_chat_id, max_images, max_allowed_generations,
         monthly_generations_count, source_track)
      VALUES (?, ?, 'trial', ?, ?, ?, ?, ?, 3, 3, 0, ?)
    `)
    .bind(slug, syntheticToken, name, name, salonType, phone,
          adminChatId ? String(adminChatId) : '0', sourceTrack ?? null)
    .run();

  return env.beauty_ai_db.prepare('SELECT * FROM salons WHERE slug = ?').bind(slug).first();
}

// ─── B2B owner onboarding (inside Standard bot) ───────────────────────────────

async function handleB2bOnboarding(message, env, userId, chatId, botToken, state, tempData) {
  const text = message.text?.trim() ?? '';

  if (state === S.B2B_NAME) {
    if (!text) {
      await sendMessage(botToken, chatId, '✍️ Введите название вашего салона или барбершопа:');
      return;
    }
    await setState(env, userId, botToken, S.B2B_PHONE, { ...tempData, b2b_name: text, salon_type: 'barber' });
    await sendMessage(botToken, chatId,
      `✅ *${text}*\n\n📱 Введите *WhatsApp-номер* для связи с клиентами:\n_(только цифры, например: \`77001112233\`)_`
    );
    return;
  }

  if (state === S.B2B_PHONE) {
    const phone = text.replace(/\D/g, '');
    if (phone.length < 10) {
      await sendMessage(botToken, chatId,
        '❌ Введите корректный номер. Например: `77001112233`'
      );
      return;
    }

    const sourceTrack = tempData.source_track ?? 'b2b_direct';
    const salonType   = tempData.salon_type ?? 'barber';
    const salon = await createTrialSalon(env, tempData.b2b_name, phone, sourceTrack, userId, salonType);

    await env.beauty_ai_db
      .prepare('INSERT OR IGNORE INTO users (user_id, bot_token, salon_id, image_count) VALUES (?, ?, ?, 0)')
      .bind(userId, botToken, salon.id).run();
    await env.beauty_ai_db
      .prepare('UPDATE users SET salon_id = ? WHERE user_id = ? AND bot_token = ?')
      .bind(salon.id, userId, botToken).run();

    const typeHints = {
      barber: '📸 Пришлите *СЕЛФИ* лица — подберём причёску!',
      makeup: '📸 Пришлите *ФОТО лица* — подберём макияж!',
      nails:  '📸 Пришлите *ФОТО рук* ладонями вверх — подберём маникюр!',
    };
    const firstStates = { barber: S.WAITING_SELFIE, makeup: S.WAITING_FACE, nails: S.WAITING_HAND };

    await sendMessage(botToken, chatId,
      `🎉 *${salon.name}* — тест-драйв запущен!\n\n` +
      `Вы попробуете бота *как ваш клиент* — доступно *3 бесплатных генерации*.\n\n` +
      `${typeHints[salonType] ?? typeHints.barber}`
    );
    await setState(env, userId, botToken, firstStates[salonType] ?? S.WAITING_SELFIE, {});
  }
}

// ─── B2B tariff / package selector (shown after trial ends) ──────────────────

async function showB2bTariffSelector(botToken, chatId, env) {
  const supportLink = env?.SUPPORT_TG_LINK ?? 'https://t.me/BeautyAI_Support';
  const workerUrl   = env?.WORKER_URL ?? 'https://beauty-ai-saas.artbycube8.workers.dev';
  const ofertaUrl   = `${workerUrl}/oferta`;
  await sendMessage(botToken, chatId,
    `✅ *Тест-драйв пройден!*\n\n` +
    `Именно так это выглядит у ваших клиентов — они примеряют причёску прямо в Telegram, ещё *до записи* к вам.\n\n` +
    `Хотите такого бота для своего салона — чтобы клиенты приходили уже заинтересованными?\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 *Тарифы — оплата раз в месяц через Kaspi:*\n\n` +
    `🟢 *Мини — ₸9,900/мес*\n` +
    `└ До ~50 клиентов в месяц\n` +
    `└ _Подойдёт для небольшого барбершопа или студии — только открываетесь или хотите попробовать_\n\n` +
    `🔵 *Стандарт — ₸14,900/мес*\n` +
    `└ До ~100 клиентов в месяц\n` +
    `└ _Для активно работающего салона — стабильный поток новых клиентов каждый месяц_\n\n` +
    `🟣 *Бизнес — ₸24,900/мес*\n` +
    `└ До ~200 клиентов в месяц\n` +
    `└ _Для загруженного салона с несколькими мастерами — максимальный охват без ограничений_\n\n` +
    `⭐ *Сеть — ₸44,900/мес*\n` +
    `└ До ~400 клиентов в месяц\n` +
    `└ _Для сети точек или крупного заведения — один бот на весь поток_\n\n` +
    `💡 _Количество клиентов рассчитано из среднего — 3 примерки на человека. Например, тариф Мини даёт 150 генераций в месяц: это ~50 уникальных клиентов по 3 примерки каждый. Хотите давать меньше примерок — клиентов поместится больше. В настройках выставляете сами._\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 *Свой бот или общий?*\n` +
    `Общий — клиенты пишут в @qrbeatyai\\_bot по вашей ссылке.\n` +
    `Свой — отдельный бот с названием вашего салона, например @chopchop\\_almaty\\_bot.\n\n` +
    `👇 Выберите тариф:`,
    { inline_keyboard: [
      [
        { text: '🟢 Мини · ₸9,900',      callback_data: 'b2b_pkg_mini_shared'  },
        { text: '🔵 Стандарт · ₸14,900', callback_data: 'b2b_pkg_std_shared'   },
      ],
      [
        { text: '🟣 Бизнес · ₸24,900',   callback_data: 'b2b_pkg_biz_shared'   },
        { text: '⭐ Сеть · ₸44,900',     callback_data: 'b2b_pkg_net_shared'   },
      ],
      [{ text: '🤖 Хочу свой бот (+₸25,000)', callback_data: 'b2b_hosting_own' }],
      [
        { text: '💬 Написать в поддержку', url: supportLink          },
        { text: '📄 Оферта',               callback_data: 'show_oferta' },
      ],
    ]}
  );
}

async function handleB2bPackageCallback(data, botToken, chatId, userId, env) {
  if (data === 'b2b_hosting_own') {
    await sendMessage(botToken, chatId,
      `🤖 *Свой личный бот (+₸25,000)*\n\n` +
      `Это значит: у вас будет отдельный бот с именем вашего салона.\n` +
      `Например, не @qrbeatyai\\_bot, а @chopchop\\_almaty\\_bot.\n\n` +
      `Клиенты видят именно ваш бренд — выглядит профессионально.\n\n` +
      `К месячной подписке добавляется разовый платёж ₸25,000.\n\n` +
      `Выберите пакет подписки 👇`,
      { inline_keyboard: [
        [
          { text: '🟢 Мини · ₸34,900',     callback_data: 'b2b_pkg_mini_own' },
          { text: '🔵 Стандарт · ₸39,900', callback_data: 'b2b_pkg_std_own'  },
        ],
        [
          { text: '🟣 Бизнес · ₸49,900',   callback_data: 'b2b_pkg_biz_own'  },
          { text: '⭐ Сеть · ₸69,900',     callback_data: 'b2b_pkg_net_own'  },
        ],
      ]}
    );
    return;
  }

  const pkg = B2B_PACKAGES[data];
  if (!pkg) return;

  const clientsPerMonth = Math.round(pkg.gens / 3);
  const hostingDesc = pkg.own
    ? 'Личный бот с именем вашего салона'
    : `Общий бот @qrbeatyai\\_bot по вашей ссылке`;

  await sendMessage(botToken, chatId,
    `✅ Отличный выбор!\n\n` +
    `📦 *Пакет «${pkg.name}»*\n` +
    `👥 До ~${clientsPerMonth} клиентов в месяц\n` +
    `🤖 ${hostingDesc}\n` +
    `💳 *₸${pkg.price.toLocaleString('ru')} в месяц*\n\n` +
    `Нажмите кнопку ниже — мы выставим счёт на оплату через Kaspi:`,
    { inline_keyboard: [[{ text: '💳 Оплатить через Kaspi', callback_data: `b2b_pay_${data}` }]] }
  );
}

// Returns the salon whose admin_chat_id matches chatId (Standard tier owner lookup).
async function findStandardOwnerSalon(env, chatId) {
  return env.beauty_ai_db
    .prepare("SELECT * FROM salons WHERE admin_chat_id = ? AND status IN ('standard_active','trial')")
    .bind(chatId).first();
}

// Returns the salon associated with a Standard-tier user via salon_id FK.
async function getStandardSalonForUser(env, userId, botToken) {
  const user = await env.beauty_ai_db
    .prepare('SELECT salon_id FROM users WHERE user_id = ? AND bot_token = ?')
    .bind(userId, botToken).first();
  if (!user?.salon_id) return null;
  return env.beauty_ai_db
    .prepare('SELECT * FROM salons WHERE id = ?')
    .bind(user.salon_id).first();
}

// ─── B2B payment flow handlers ────────────────────────────────────────────────

async function handleB2bAwaitingPhone(message, env, userId, chatId, botToken, tempData) {
  const phone = (message.text ?? '').replace(/\D/g, '');
  if (phone.length < 10) {
    await sendMessage(botToken, chatId, '❌ Введите корректный номер телефона (только цифры).\n_Например: 77001112233_');
    return;
  }

  const pkg     = B2B_PACKAGES[tempData.pkg_key];
  const pkgName = tempData.pkg_name ?? 'выбранный пакет';
  const price   = tempData.pkg_price ?? 0;

  await setState(env, userId, botToken, S.B2B_AWAITING_CHEQUE, { ...tempData, kaspi_phone: phone });

  await sendMessage(botToken, chatId,
    `⏳ Счет на *₸${price.toLocaleString('ru')}* будет выставлен на номер *+${phone}*!\n\n` +
    `Пожалуйста, оплатите его в приложении Kaspi и пришлите сюда *скриншот/фото чека* для активации доступа.`
  );

  // Notify admin to send Kaspi invoice
  if (env.ADMIN_USER_ID) {
    await sendMessage(env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN, String(env.ADMIN_USER_ID),
      `💳 *Выставить счет Kaspi*\n\n` +
      `Пакет: *${pkgName}${pkg?.own ? ' + свой бот' : ''}*\n` +
      `Сумма: *₸${price.toLocaleString('ru')}*\n` +
      `Номер: \`${phone}\`\n` +
      `Chat ID: \`${chatId}\``
    );
  }
}

async function handleB2bCheque(message, env, userId, chatId, botToken, tempData) {
  const isPhoto = !!message.photo;
  const isDoc   = !!message.document;

  if (!isPhoto && !isDoc) {
    await sendMessage(botToken, chatId, '📸 Пришлите фото или файл (PDF) чека об оплате.');
    return;
  }

  // Anti-spam: lock state immediately so media-group duplicates are ignored
  await setState(env, userId, botToken, S.B2B_CONFIRMATION_PENDING, tempData);

  const pkgKey  = tempData.pkg_key ?? '';
  const pkg     = B2B_PACKAGES[pkgKey];
  const pkgName = tempData.pkg_name ?? '—';
  const price   = tempData.pkg_price ?? 0;
  const phone   = tempData.kaspi_phone ?? '—';
  const isOwn   = tempData.pkg_is_own ?? false;
  const short   = pkg?.short ?? 'un';

  const caption =
    `🧾 *Чек об оплате*\n\n` +
    `Пакет: *${pkgName}${isOwn ? ' + свой бот' : ''}*\n` +
    `Сумма: ₸${price.toLocaleString('ru')}\n` +
    `Телефон: \`${phone}\`\n` +
    `Chat ID: \`${chatId}\``;

  // callback_data: "pok:<userId>:<short>" max ~26 chars — well under 64 limit
  const replyMarkup = JSON.stringify({ inline_keyboard: [[
    { text: '✅ Подтвердить', callback_data: `pok:${userId}:${short}` },
    { text: '❌ Отклонить',  callback_data: `pno:${userId}` },
  ]]});

  const adminToken = env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN;
  const form = new FormData();
  form.append('chat_id', String(env.ADMIN_USER_ID));
  form.append('caption', caption);
  form.append('parse_mode', 'Markdown');
  form.append('reply_markup', replyMarkup);

  if (isPhoto) {
    const photo   = message.photo[message.photo.length - 1];
    const fileUrl = await getTelegramFileUrl(botToken, photo.file_id);
    const blob    = await (await fetch(fileUrl)).blob();
    form.append('photo', new File([blob], 'cheque.jpg', { type: 'image/jpeg' }), 'cheque.jpg');
    await fetch(`${TELEGRAM_API}/bot${adminToken}/sendPhoto`, { method: 'POST', body: form });
  } else {
    const doc     = message.document;
    const fileUrl = await getTelegramFileUrl(botToken, doc.file_id);
    const blob    = await (await fetch(fileUrl)).blob();
    const fname   = doc.file_name ?? 'cheque.pdf';
    form.append('document', new File([blob], fname, { type: doc.mime_type ?? 'application/octet-stream' }), fname);
    await fetch(`${TELEGRAM_API}/bot${adminToken}/sendDocument`, { method: 'POST', body: form });
  }

  await sendMessage(botToken, chatId,
    `✅ Спасибо! Чек отправлен на проверку.\n\n⏱ Это займёт не более 5 минут — ожидайте уведомления здесь.`
  );
}

async function handleB2bToken(message, env, userId, chatId, botToken, tempData) {
  const token = (message.text ?? '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(token)) {
    await sendMessage(botToken, chatId,
      '❌ Неверный формат токена.\n\nОн должен выглядеть так:\n`1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxx`\n\nПопробуйте ещё раз:'
    );
    return;
  }

  await sendMessage(botToken, chatId, '⏳ Проверяем токен...');

  // Validate the token via Telegram
  const meResp = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
  const meData = await meResp.json();
  if (!meData.ok) {
    await sendMessage(botToken, chatId,
      `❌ Токен недействителен: _${meData.description}_\n\nПроверьте токен в @BotFather и попробуйте ещё раз:`
    );
    return;
  }
  const botUsername = meData.result.username;

  // Check for conflicts
  const conflict = await env.beauty_ai_db
    .prepare('SELECT id FROM salons WHERE bot_token = ?').bind(token).first();
  if (conflict) {
    await sendMessage(botToken, chatId,
      '❌ Этот токен уже используется другим салоном.\n\nСоздайте нового бота в @BotFather и пришлите его токен:'
    );
    return;
  }

  // Find the owner's salon
  const salon = await env.beauty_ai_db
    .prepare('SELECT * FROM salons WHERE admin_chat_id = ?').bind(userId).first();
  if (!salon) {
    await sendMessage(botToken, chatId, '❌ Салон не найден. Обратитесь в поддержку.');
    return;
  }

  // Register webhook for the new premium bot
  const workerUrl  = env.WORKER_URL.replace(/\/$/, '');
  const webhookUrl = `${workerUrl}/webhook/${encodeURIComponent(token)}`;
  const whResp = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] }),
  });
  const whData = await whResp.json();
  if (!whData.ok) {
    await sendMessage(botToken, chatId, `⚠️ Не удалось зарегистрировать вебхук: ${whData.description}\n\nОбратитесь в поддержку.`);
    return;
  }

  // Update salon to use the new premium token
  await env.beauty_ai_db
    .prepare('UPDATE salons SET bot_token = ? WHERE id = ?')
    .bind(token, salon.id).run();

  // Clear owner state on the standard bot
  await setState(env, userId, botToken, 'start', {});

  const botLink = `https://t.me/${botUsername}`;
  await sendMessage(botToken, userId,
    `🚀 *Ваш личный бот подключён!*\n\nБот: @${botUsername}\n\n🔗 Ссылка для клиентов:\n\`${botLink}\`\n\nПоделитесь ею с клиентами — они сразу попадут к вашему боту.`,
    ownerMenuKeyboard()
  );
  await sendQrCode(botToken, userId, botLink);

  // Notify admin for audit trail
  if (env.ADMIN_USER_ID) {
    const adminToken = env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN;
    await sendMessage(adminToken, String(env.ADMIN_USER_ID),
      `🤖 *Самоподключение Premium-бота*\n\nВладелец: \`${userId}\`\nСалон: *${salon.name ?? salon.salon_name}*\nБот: @${botUsername}`
    );
  }
}

// ─── Admin B2B payment confirmation ──────────────────────────────────────────

async function confirmB2bPayment(env, adminChatId, data) {
  // data: pok:<userId>:<shortCode>  e.g. pok:8024227480:mi_s
  const parts     = data.split(':');
  const userId    = parts[1];
  const shortCode = parts[2] ?? '';
  const pkgKey    = PKG_SHORT[shortCode];
  const pkg       = B2B_PACKAGES[pkgKey];
  const botToken  = env.STANDARD_BOT_TOKEN;

  // Look up user's state to get context
  const stateRow = await env.beauty_ai_db
    .prepare('SELECT temp_data FROM user_states WHERE user_id = ? AND bot_token = ?')
    .bind(userId, botToken).first();
  const tempData = JSON.parse(stateRow?.temp_data ?? '{}');

  // Find the user's salon
  const salon = await env.beauty_ai_db
    .prepare('SELECT * FROM salons WHERE admin_chat_id = ?')
    .bind(userId).first();

  if (salon && pkg) {
    const now       = new Date();
    const paidUntil = new Date(now);
    paidUntil.setMonth(paidUntil.getMonth() + 1);
    const paidUntilStr = paidUntil.toISOString().slice(0, 10);

    await env.beauty_ai_db
      .prepare(`UPDATE salons
                SET status = 'standard_active',
                    plan_name = ?,
                    plan_limit = ?,
                    max_allowed_generations = ?,
                    monthly_generations_count = 0,
                    plan_used = 0,
                    paid_until = ?,
                    plan_reset_at = ?
                WHERE id = ?`)
      .bind(pkg.name, pkg.gens, pkg.gens, paidUntilStr, paidUntilStr, salon.id)
      .run();
  }

  if (pkg?.own) {
    // Premium: let owner choose self-service or support
    await setState(env, userId, botToken, S.B2B_AWAITING_TOKEN, tempData);
    await sendMessage(botToken, userId,
      `🎉 *Оплата подтверждена! Пакет "${pkg.name} + свой бот" активирован.*\n\n` +
      `Отлично! Теперь нужно подключить вашего личного бота.\n\n` +
      `Как вам удобнее?`,
      { inline_keyboard: [[
        { text: '🔧 Подключу сам', callback_data: 'b2b_own_self' },
        { text: '💬 Через поддержку', callback_data: 'b2b_own_support' },
      ]]}
    );
  } else {
    // Shared: activate and show salon panel, then send QR + client link
    await setState(env, userId, botToken, 'start', {});
    const botUsername = env.STANDARD_BOT_USERNAME ?? 'qrbeatyai_bot';
    const clientLink  = salon?.slug
      ? `https://t.me/${botUsername}?start=${salon.slug}`
      : null;
    await sendMessage(botToken, userId,
      `🎉 *Оплата подтверждена! Пакет "${pkg?.name ?? 'выбранный'}" активирован.*\n\n` +
      `Ваш ИИ-ассистент готов к работе! Клиенты уже могут пользоваться им.`,
      ownerMenuKeyboard()
    );
    if (clientLink) {
      await sendQrCode(botToken, userId, clientLink);
    }
  }

  const adminToken = env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN;
  await sendMessage(adminToken, adminChatId, `✅ Оплата подтверждена для пользователя \`${userId}\`.`);
}

async function rejectB2bPayment(env, adminChatId, data) {
  const userId   = data.split(':')[1];
  const botToken = env.STANDARD_BOT_TOKEN;

  await setState(env, userId, botToken, 'start', {});
  await sendMessage(botToken, userId,
    `❌ *Оплата не подтверждена.*\n\nПожалуйста, свяжитесь с поддержкой для уточнения деталей.`
  );

  const adminToken = env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN;
  await sendMessage(adminToken, adminChatId, `❌ Оплата отклонена для пользователя \`${userId}\`.`);
}

async function launchB2bPremiumBot(env, adminChatId, data) {
  const userId   = data.split(':')[1];
  const botToken = env.STANDARD_BOT_TOKEN;

  const stateRow = await env.beauty_ai_db
    .prepare('SELECT temp_data FROM user_states WHERE user_id = ? AND bot_token = ?')
    .bind(userId, botToken).first();
  const tempData = JSON.parse(stateRow?.temp_data ?? '{}');
  const premiumToken = tempData.premium_token;

  if (premiumToken) {
    // Register webhook for the new premium bot
    const workerUrl  = env.WORKER_URL.replace(/\/$/, '');
    const webhookUrl = `${workerUrl}/webhook/${encodeURIComponent(premiumToken)}`;
    await fetch(`${TELEGRAM_API}/bot${premiumToken}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] }),
    });
  }

  await setState(env, userId, botToken, 'start', {});
  await sendMessage(botToken, userId,
    `🚀 *Ваш персональный бот запущен и готов к работе!*\n\n` +
    `Клиенты теперь могут пользоваться вашим личным ботом.`,
    ownerMenuKeyboard()
  );

  const adminToken = env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN;
  await sendMessage(adminToken, adminChatId, `✅ Бот клиента \`${userId}\` успешно запущен.`);
}

async function sendWelcomePhotos(botToken, chatId, env) {
  const [row1, row2] = await Promise.all([
    env.beauty_ai_db.prepare("SELECT value FROM settings WHERE key = 'welcome_photo_1'").first(),
    env.beauty_ai_db.prepare("SELECT value FROM settings WHERE key = 'welcome_photo_2'").first(),
  ]);
  if (row1 && row2) {
    await fetch(`${TELEGRAM_API}/bot${botToken}/sendMediaGroup`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        chat_id: chatId,
        media  : [
          { type: 'photo', media: row1.value },
          { type: 'photo', media: row2.value },
        ],
      }),
    });
  } else if (row1) {
    await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id: chatId, photo: row1.value }),
    });
  }
}

// ─── /start ──────────────────────────────────────────────────────────────────
async function onStart(message, salon, botToken, chatId, env) {
  const maxImages = salon.max_images ?? 3;

  await sendWelcomePhotos(botToken, chatId, env);

  const greetings = {
    barber: `✂️ *${salon.salon_name}* — ИИ-подбор причёски\n\nЗагрузите селфи и за 60 секунд увидите себя с новой стрижкой — прямо здесь в Telegram.\n\n_${maxImages} бесплатных примерки 🎁_\n\n👇 Поделитесь контактом чтобы начать:`,

    makeup: `💄 *${salon.salon_name}* — ИИ-подбор макияжа\n\nЗагрузите фото лица и за 60 секунд увидите профессиональный образ — прямо здесь в Telegram.\n\n_${maxImages} бесплатных примерки 🎁_\n\n👇 Поделитесь контактом чтобы начать:`,

    nails: `💅 *${salon.salon_name}* — ИИ-подбор маникюра\n\nЗагрузите фото рук и за 60 секунд увидите трендовый дизайн на своих ногтях — прямо здесь в Telegram.\n\n_${maxImages} бесплатных примерки 🎁_\n\n👇 Поделитесь контактом чтобы начать:`,
  };

  await sendMessage(
    botToken, chatId,
    greetings[salon.salon_type] ?? greetings.barber,
    contactKeyboard()
  );
}

// ─── Contact received ─────────────────────────────────────────────────────────
async function onContact(message, salon, user, env, botToken, chatId, userId) {
  const contact = message.contact;
  const name    = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
                  || message.from.first_name
                  || 'Клиент';
  const phone   = contact.phone_number;

  // Persist contact — photos NEVER leave this user↔bot dialog
  await env.beauty_ai_db
    .prepare('UPDATE users SET phone = ?, name = ? WHERE user_id = ? AND bot_token = ?')
    .bind(phone, name, userId, botToken)
    .run();

  // Notify admin — DRY text only, no photos
  await sendMessage(
    botToken, salon.admin_chat_id,
    `🔔 *Новый клиент!*\n\n👤 Имя: ${name}\n📱 Телефон: \`${phone}\`\n🤖 Бот: ${salon.salon_name}\n📍 Источник: Telegram ИИ-бот`
  );

  // Next step depends on salon type
  const steps = {
    barber: {
      text  : `✅ Отлично, ${name}!\n\n📸 Теперь пришлите *СЕЛФИ* — чёткое, фронтально, при хорошем свете.\n\n_Я подберу вам новую причёску за ~60 секунд._`,
      state : S.WAITING_SELFIE,
    },
    makeup: {
      text  : `✅ Отлично, ${name}!\n\n📸 Теперь пришлите *ФОТО лица* — чёткое, фронтально, при хорошем свете.\n\n_Я создам ваш образ за ~60 секунд._`,
      state : S.WAITING_FACE,
    },
    nails: {
      text  : `✅ Отлично, ${name}!\n\n📸 Теперь пришлите *ФОТО рук* ладонями вверх, при хорошем свете.\n\n_Я подберу вам дизайн маникюра за ~60 секунд._`,
      state : S.WAITING_HAND,
    },
  };

  const step = steps[salon.salon_type] ?? steps.barber;
  await sendMessage(botToken, chatId, step.text, { remove_keyboard: true });
  await setState(env, userId, botToken, step.state, {});
}

// ─── Photo received ───────────────────────────────────────────────────────────
async function onPhoto(message, salon, user, state, tempData, env, botToken, chatId, userId) {
  const maxImages = salon.max_images ?? 3;

  if ((user.image_count ?? 0) >= maxImages) {
    await sendOfferMessage(botToken, chatId, salon);
    return;
  }

  // Use the highest-resolution version Telegram provides
  const photo    = message.photo[message.photo.length - 1];
  const fileUrl  = await getTelegramFileUrl(botToken, photo.file_id);

  switch (salon.salon_type) {
    case 'barber': await handleBarber(state, tempData, fileUrl, salon, user, env, botToken, chatId, userId, maxImages); break;
    case 'makeup': await handleMakeup(fileUrl, salon, user, env, botToken, chatId, userId, maxImages);                  break;
    case 'nails':  await handleNails(fileUrl, salon, user, env, botToken, chatId, userId, maxImages);                   break;
  }
}

// ─── Barber flow: selfie → gender → style → color → FLUX Kontext ─────────────
async function handleBarber(state, tempData, fileUrl, salon, user, env, botToken, chatId, userId, maxImages) {
  if (state === S.WAITING_SELFIE) {
    await setState(env, userId, botToken, S.WAITING_STYLE_CHOICE, { selfie_url: fileUrl });
    await sendMessage(botToken, chatId,
      `✅ Селфи получено!\n\n👤 Для кого подбираем причёску?`,

      genderKeyboard()
    );
  }
}

// ─── Salon inline keyboard handler ───────────────────────────────────────────
async function handleSalonCallback(cq, salon, env) {
  const userId   = String(cq.from.id);
  const chatId   = String(cq.message.chat.id);
  const botToken = salon.bot_token;
  const data     = cq.data;

  await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ callback_query_id: cq.id }),
  });

  const stateRow = await env.beauty_ai_db
    .prepare('SELECT * FROM user_states WHERE user_id = ? AND bot_token = ?')
    .bind(userId, botToken).first();
  const state    = stateRow?.state;
  const tempData = JSON.parse(stateRow?.temp_data ?? '{}');

  // ── Salon owner tariff selection ──
  if (data.startsWith('stariff_') && chatId === String(salon.admin_chat_id)) {
    const tariffKey = data.replace('stariff_', '');
    const tariff    = TARIFFS[tariffKey];
    if (!tariff) return;
    await setState(env, userId, botToken, S.SALON_TARIFF_RECEIPT, { selected_tariff: tariffKey });
    await sendMessage(env.ADMIN_BOT_TOKEN, env.ADMIN_USER_ID,
      `💳 *Запрос тарифа*\n\nСалон: *${salon.salon_name}*\nТариф: *${tariff.name}* · ${tariff.limit} ген.\nСумма: *₸${tariff.price.toLocaleString('ru')}*\n\nВыставьте счёт на Kaspi и ожидайте чек.`
    );
    await sendMessage(botToken, chatId,
      `✅ Заявка на тариф *${tariff.name}* отправлена!\n\n💳 Менеджер выставит счёт на оплату через Kaspi в ближайшее время.\n\nКогда оплатите — пришлите *скриншот чека* в этот чат.`
    );
    return;
  }

  // ── Salon owner settings edit callbacks ──
  if (data.startsWith('sedit_') && chatId === String(salon.admin_chat_id)) {
    if (data === 'sedit_name') {
      await setState(env, userId, botToken, S.SALON_EDIT_NAME, {});
      await sendMessage(botToken, chatId, '✏️ Введите *новое название* салона (или /cancel для отмены):');
      return;
    }
    if (data === 'sedit_phone') {
      await setState(env, userId, botToken, S.SALON_EDIT_PHONE, {});
      await sendMessage(botToken, chatId, '📱 Введите *новый WhatsApp-номер* (только цифры, или /cancel):\n_Например: 77001112233_');
      return;
    }
    if (data === 'sedit_type') {
      await sendMessage(botToken, chatId, '🏷️ Выберите *тип салона*:', salonTypeKeyboard('sedit_type'));
      return;
    }
    if (data.startsWith('sedit_type_')) {
      const newType = data.replace('sedit_type_', '');
      const typeNames = { barber: 'Барбершоп / Стрижки', makeup: 'Макияж / Студия красоты', nails: 'Ногти / Маникюр' };
      await env.beauty_ai_db
        .prepare('UPDATE salons SET salon_type = ? WHERE id = ?')
        .bind(newType, salon.id).run();
      await sendMessage(botToken, chatId, `✅ Тип обновлён: *${typeNames[newType] ?? newType}*`, ownerMenuKeyboard());
      return;
    }
    if (data === 'sedit_max') {
      const cur = salon.max_images ?? 3;
      await sendMessage(botToken, chatId,
        `🎯 *Лимит примерок на одного клиента*\n\n` +
        `Сейчас: *${cur}*\n\n` +
        `После того как клиент использует все примерки — бот предложит ему записаться в WhatsApp.\n\n` +
        `Выберите сколько примерок давать каждому клиенту:`,
        { inline_keyboard: [
          [
            { text: '1', callback_data: 'sedit_max_1' },
            { text: '2', callback_data: 'sedit_max_2' },
            { text: '3', callback_data: 'sedit_max_3' },
          ],
          [
            { text: '5', callback_data: 'sedit_max_5' },
            { text: '7', callback_data: 'sedit_max_7' },
            { text: '10', callback_data: 'sedit_max_10' },
          ],
        ]}
      );
      return;
    }
    if (data.startsWith('sedit_max_')) {
      const newMax = parseInt(data.replace('sedit_max_', '')) || 3;
      await env.beauty_ai_db
        .prepare('UPDATE salons SET max_images = ? WHERE id = ?')
        .bind(newMax, salon.id).run();
      await sendMessage(botToken, chatId,
        `✅ Готово! Каждый клиент теперь получает *${newMax}* примерки.`,
        ownerMenuKeyboard()
      );
      return;
    }
    return;
  }

  // ── Salon owner push callbacks ──
  if (data.startsWith('spush_') && chatId === String(salon.admin_chat_id)) {
    await handleSalonPushCallback(data, salon, tempData, env, botToken, chatId, userId);
    return;
  }

  // ── Gender selection ──
  if (data.startsWith('gender_') && state === S.WAITING_STYLE_CHOICE) {
    const gender = data === 'gender_male' ? 'male' : 'female';
    await setState(env, userId, botToken, S.WAITING_STYLE_CHOICE, { ...tempData, gender });
    const kb = gender === 'male' ? maleStylesKeyboard() : femaleStylesKeyboard();
    await sendMessage(botToken, chatId, '💇 Выберите *стиль причёски*:', kb);
    return;
  }

  // ── Style selection ──
  if ((data.startsWith('mstyle_') || data.startsWith('fstyle_')) && state === S.WAITING_STYLE_CHOICE) {
    const storedGender = tempData.gender;
    // Guard against stale keyboard buttons from previous sessions
    const callbackIsMale = data.startsWith('mstyle_');
    if (!storedGender) {
      await sendMessage(botToken, chatId, '👆 Сначала выберите для кого причёска:', genderKeyboard());
      return;
    }
    if (callbackIsMale && storedGender !== 'male') {
      await sendMessage(botToken, chatId, '👆 Выберите стиль причёски:', femaleStylesKeyboard());
      return;
    }
    if (!callbackIsMale && storedGender !== 'female') {
      await sendMessage(botToken, chatId, '👆 Выберите стиль причёски:', maleStylesKeyboard());
      return;
    }
    const isMale  = callbackIsMale;
    const key     = data.replace(isMale ? 'mstyle_' : 'fstyle_', '');
    const preset  = (isMale ? MALE_STYLES : FEMALE_STYLES)[key];
    if (!preset) return;

    const isDefault = key === 'default';
    await setState(env, userId, botToken, S.WAITING_COLOR, {
      ...tempData,
      style_label     : preset.label,
      style_prompt    : preset.hairPrompt,
      style_is_default: isDefault,
      style_is_male   : isMale,
    });
    const colorPrompt = isDefault
      ? `✅ Оставляем вашу причёску!\n\n🎨 Выберите *новый цвет волос*:`
      : `✅ Стиль: *${preset.label}*\n\n🎨 Выберите *цвет волос* (или оставьте свой):`;
    await sendMessage(botToken, chatId, colorPrompt, colorKeyboard());
    return;
  }

  // ── Color selection → submit job ──
  if (data.startsWith('color_') && state === S.WAITING_COLOR) {
    const colorKey = data.replace('color_', '');
    const color    = HAIR_COLORS[colorKey];
    if (!color || !tempData.selfie_url || !tempData.style_prompt) {
      await sendMessage(botToken, chatId, '⚠️ Что-то пошло не так. Начните заново — пришлите селфи.');
      await setState(env, userId, botToken, S.WAITING_SELFIE, {});
      return;
    }

    // "Своя причёска" + "Свой цвет" — менять нечего, просим выбрать цвет
    if (tempData.style_is_default && !color.colorPrompt) {
      await sendMessage(botToken, chatId,
        '🎨 Вы оставляете свою причёску — тогда нужно выбрать *новый цвет* волос.\n\nВыберите цвет из списка:',
        colorKeyboard()
      );
      return;
    }

    const user = await env.beauty_ai_db
      .prepare('SELECT * FROM users WHERE user_id = ? AND bot_token = ?')
      .bind(userId, botToken).first();
    if ((user?.image_count ?? 0) >= (salon.max_images ?? 3)) {
      await sendOfferMessage(botToken, chatId, salon);
      return;
    }

    // Monthly salon limit — block before submitting to fal.ai
    if (isMonthlyLimitReached(salon)) {
      await sendMessage(botToken, chatId,
        '⏸ Извините, на этот месяц лимит примерок в этом салоне исчерпан. ' +
        'Сервис возобновит работу в начале следующего месяца.'
      );
      return;
    }

    const colorPart = color.colorPrompt ? ` Also color the hair to ${color.colorPrompt}.` : '';
    const faceLock  = tempData.style_is_male === false ? FACE_LOCK_F : FACE_LOCK_M;
    const fullPrompt = faceLock + tempData.style_prompt + colorPart;

    const styleLabel = tempData.style_label ?? '';
    const colorLabel = color.label !== '✅ Мой цвет' ? ` · ${color.label}` : '';
    await sendMessage(botToken, chatId,
      `⏳ Генерирую *${styleLabel}${colorLabel}*… Пришлю вам результат через ~60 секунд. ✨`
    );

    try {
      await submitFluxKontext(tempData.selfie_url, fullPrompt, { userId, botToken, chatId, salonId: salon.id }, env);
      await setState(env, userId, botToken, S.PROCESSING, {});
    } catch (err) {
      console.error('FLUX Kontext error:', err);
      await sendMessage(botToken, chatId, '❌ Не удалось отправить задачу. Попробуй ещё раз.');
      await setState(env, userId, botToken, S.WAITING_SELFIE, {});
    }
  }
}

// ─── Salon tariff: receipt forwarding + assignment ────────────────────────────

async function handleOwnerReceipt(message, salon, tempData, env, botToken, chatId, userId) {
  const tariffKey = tempData.selected_tariff;
  const tariff    = TARIFFS[tariffKey];
  if (!tariff) {
    await sendMessage(botToken, chatId, '❌ Тариф не выбран. Напишите любое сообщение чтобы выбрать снова.');
    await setState(env, userId, botToken, 'start', {});
    return;
  }

  const photo   = message.photo[message.photo.length - 1];
  const fileUrl = await getTelegramFileUrl(botToken, photo.file_id);

  // Download from salon bot then re-upload via admin bot (file_id is bot-specific)
  const imgRes = await fetch(fileUrl);
  const blob   = await imgRes.blob();

  const salonRow = await env.beauty_ai_db
    .prepare('SELECT id FROM salons WHERE bot_token = ?')
    .bind(botToken).first();

  const caption = `🧾 *Чек об оплате*\n\nСалон: *${salon.salon_name}*\nТариф: *${tariff.name}* · ${tariff.limit} ген. · ₸${tariff.price.toLocaleString('ru')}\n\nПроверьте оплату и нажмите кнопку:`;

  const form = new FormData();
  form.append('chat_id', String(env.ADMIN_USER_ID));
  form.append('photo', new File([blob], 'receipt.jpg', { type: 'image/jpeg' }), 'receipt.jpg');
  form.append('caption', caption);
  form.append('parse_mode', 'Markdown');
  form.append('reply_markup', JSON.stringify({ inline_keyboard: [[
    { text: `✅ Выдать тариф «${tariff.name}»`, callback_data: `asgn_${salonRow.id}_${tariffKey}` },
  ]]}));

  const adminToken = env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN;
  const res = await fetch(`${TELEGRAM_API}/bot${adminToken}/sendPhoto`, {
    method: 'POST',
    body  : form,
  });
  if (!res.ok) console.error('[receipt] sendPhoto to admin failed:', await res.text());

  await setState(env, userId, botToken, 'start', {});
  await sendMessage(botToken, chatId,
    '✅ Чек отправлен менеджеру! Тариф активируют в ближайшие минуты — ожидайте уведомления.'
  );
}

async function assignTariff(env, salonId, tariffKey, adminChatId) {
  const tariff = TARIFFS[tariffKey];
  if (!tariff) return;

  const now       = new Date();
  const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const resetAt   = resetDate.toISOString().slice(0, 10);

  await env.beauty_ai_db
    .prepare('UPDATE salons SET plan_name = ?, plan_limit = ?, plan_used = 0, plan_reset_at = ? WHERE id = ?')
    .bind(tariff.name, tariff.limit, resetAt, salonId)
    .run();

  const salon = await env.beauty_ai_db
    .prepare('SELECT * FROM salons WHERE id = ?')
    .bind(salonId).first();

  await sendMessage(salon.bot_token, salon.admin_chat_id,
    `🎉 *Тариф «${tariff.name}» активирован!*\n\n✅ Доступно: *${tariff.limit} генераций в месяц*\n📅 Сбрасывается 1-го числа каждого месяца\n\nВаши клиенты уже могут пользоваться ботом! 🚀`
  );

  await sendMessage(env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN, adminChatId,
    `✅ Тариф *${tariff.name}* выдан салону *${salon.salon_name}*`
  );
}

// ─── Salon owner push broadcast ──────────────────────────────────────────────

function pushButtonChoiceKeyboard() {
  return { inline_keyboard: [
    [{ text: '📲 Кнопка «Записаться»', callback_data: 'spush_btn_wa' }],
    [{ text: '✏️ Своя кнопка',         callback_data: 'spush_btn_custom' }],
    [{ text: '🚫 Без кнопки',          callback_data: 'spush_btn_none' }],
  ]};
}

function pushConfirmKeyboard() {
  return { inline_keyboard: [
    [{ text: '✅ Отправить', callback_data: 'spush_confirm' }],
    [{ text: '❌ Отменить',  callback_data: 'spush_cancel'  }],
  ]};
}

function buildPushPreview(pushText, pushButtons) {
  const btnLine = pushButtons?.length
    ? `\n\n🔘 Кнопка: *${pushButtons[0].text}*`
    : '\n\n_(без кнопки)_';
  return `👁 *Превью:*\n\n${pushText}${btnLine}`;
}

async function handleSalonPushMessage(message, salon, tempData, env, botToken, chatId, userId) {
  const stateRow = await env.beauty_ai_db
    .prepare('SELECT state FROM user_states WHERE user_id = ? AND bot_token = ?')
    .bind(userId, botToken).first();
  const state = stateRow?.state;

  if (state === S.SALON_PUSH_TEXT) {
    const text = message.text?.trim();
    if (!text) {
      await sendMessage(botToken, chatId, '✍️ Напиши текст рассылки:');
      return;
    }
    await setState(env, userId, botToken, S.SALON_PUSH_BUTTONS, { push_text: text });
    await sendMessage(botToken, chatId,
      '🔘 Добавить кнопку к сообщению?',
      pushButtonChoiceKeyboard()
    );
    return;
  }

  if (state === S.SALON_PUSH_BUTTONS) {
    // Owner typed custom button in format "Текст | URL"
    const input = message.text?.trim() ?? '';
    const sep   = input.indexOf('|');
    if (sep === -1) {
      await sendMessage(botToken, chatId,
        '❌ Формат неверный. Напиши так:\n`Текст кнопки | https://ссылка`'
      );
      return;
    }
    const btnText = input.slice(0, sep).trim();
    const btnUrl  = input.slice(sep + 1).trim();
    if (!btnUrl.startsWith('http')) {
      await sendMessage(botToken, chatId,
        '❌ Ссылка должна начинаться с https://\nПопробуй ещё раз:'
      );
      return;
    }
    const pushButtons = [{ text: btnText, url: btnUrl }];
    await setState(env, userId, botToken, S.SALON_PUSH_CONFIRM, { ...tempData, push_buttons: pushButtons });
    const clientCount = await getPushClientCount(env, botToken, salon.id);
    await sendMessage(botToken, chatId,
      `${buildPushPreview(tempData.push_text, pushButtons)}\n\n👥 Получат: *${clientCount}* клиентов`,
      pushConfirmKeyboard()
    );
    return;
  }
}

async function handleSalonPushCallback(data, salon, tempData, env, botToken, chatId, userId) {
  if (data === 'spush_btn_wa') {
    const phone   = salon.whatsapp_phone;
    const waUrl   = `https://wa.me/${phone}`;
    const buttons = [{ text: '📲 Записаться', url: waUrl }];
    await setState(env, userId, botToken, S.SALON_PUSH_CONFIRM, { ...tempData, push_buttons: buttons });
    const clientCount = await getPushClientCount(env, botToken, salon.id);
    await sendMessage(botToken, chatId,
      `${buildPushPreview(tempData.push_text, buttons)}\n\n👥 Получат: *${clientCount}* клиентов`,
      pushConfirmKeyboard()
    );
    return;
  }

  if (data === 'spush_btn_custom') {
    await setState(env, userId, botToken, S.SALON_PUSH_BUTTONS, tempData);
    await sendMessage(botToken, chatId,
      '✏️ Напиши кнопку в формате:\n`Текст кнопки | https://ссылка`\n\nНапример:\n`Записаться | https://wa.me/77001234567`'
    );
    return;
  }

  if (data === 'spush_btn_none') {
    await setState(env, userId, botToken, S.SALON_PUSH_CONFIRM, { ...tempData, push_buttons: [] });
    const clientCount = await getPushClientCount(env, botToken, salon.id);
    await sendMessage(botToken, chatId,
      `${buildPushPreview(tempData.push_text, [])}\n\n👥 Получат: *${clientCount}* клиентов`,
      pushConfirmKeyboard()
    );
    return;
  }

  if (data === 'spush_confirm') {
    const { push_text, push_buttons } = tempData;
    if (!push_text) {
      await sendMessage(botToken, chatId, '❌ Нет текста. Начни заново — /push');
      await setState(env, userId, botToken, 'start', {});
      return;
    }
    await setState(env, userId, botToken, 'start', {});
    await sendMessage(botToken, chatId, '⏳ Рассылка отправляется...');
    const sent = await sendSalonPush(env, botToken, push_text, push_buttons ?? [], salon.id);
    await sendMessage(botToken, chatId, `✅ Рассылка отправлена *${sent}* клиентам!`);
    return;
  }

  if (data === 'spush_cancel') {
    await setState(env, userId, botToken, 'start', {});
    await sendMessage(botToken, chatId, '❌ Рассылка отменена.', { remove_keyboard: true });
    return;
  }
}

async function handleSalonEdit(message, salon, state, env, botToken, chatId, userId) {
  const text = message.text?.trim() ?? '';

  if (text === '/cancel') {
    await setState(env, userId, botToken, 'start', {});
    await sendMessage(botToken, chatId, '✅ Изменение отменено.', ownerMenuKeyboard());
    return;
  }

  if (state === S.SALON_EDIT_NAME) {
    if (!text) {
      await sendMessage(botToken, chatId, '✍️ Введите новое название (или /cancel для отмены):');
      return;
    }
    await env.beauty_ai_db
      .prepare('UPDATE salons SET name = ?, salon_name = ? WHERE id = ?')
      .bind(text, text, salon.id).run();
    await setState(env, userId, botToken, 'start', {});
    await sendMessage(botToken, chatId, `✅ Название обновлено: *${text}*`, ownerMenuKeyboard());
    return;
  }

  if (state === S.SALON_EDIT_PHONE) {
    const phone = text.replace(/\D/g, '');
    if (phone.length < 10) {
      await sendMessage(botToken, chatId,
        '❌ Введите корректный номер (только цифры, минимум 10 знаков).\n_Например: 77001112233_'
      );
      return;
    }
    await env.beauty_ai_db
      .prepare('UPDATE salons SET whatsapp_phone = ? WHERE id = ?')
      .bind(phone, salon.id).run();
    await setState(env, userId, botToken, 'start', {});
    await sendMessage(botToken, chatId, `✅ WhatsApp обновлён: \`${phone}\``, ownerMenuKeyboard());
    return;
  }
}

async function getPushClientCount(env, botToken, salonId) {
  const row = salonId
    ? await env.beauty_ai_db
        .prepare('SELECT COUNT(*) as cnt FROM users WHERE salon_id = ?')
        .bind(salonId).first()
    : await env.beauty_ai_db
        .prepare('SELECT COUNT(*) as cnt FROM users WHERE bot_token = ?')
        .bind(botToken).first();
  return row?.cnt ?? 0;
}

async function sendSalonPush(env, botToken, text, buttons, salonId) {
  const { results: clients } = salonId
    ? await env.beauty_ai_db
        .prepare('SELECT DISTINCT user_id FROM users WHERE salon_id = ?')
        .bind(salonId).all()
    : await env.beauty_ai_db
        .prepare('SELECT DISTINCT user_id FROM users WHERE bot_token = ?')
        .bind(botToken).all();

  const replyMarkup = buttons.length
    ? { inline_keyboard: [buttons.map(b => ({ text: b.text, url: b.url }))] }
    : null;

  let sent = 0;
  for (const client of clients) {
    try {
      await sendMessage(botToken, client.user_id, text, replyMarkup);
      sent++;
    } catch { /* user may have blocked bot */ }
  }
  return sent;
}

// ─── FLUX Kontext — image editing with identity preservation ─────────────────
// Docs: https://fal.ai/models/fal-ai/flux-pro/kontext/api
async function submitFluxKontext(imageUrl, prompt, meta, env) {
  const workerUrl = env.WORKER_URL.replace(/\/$/, '');

  const res = await fetch(`${FAL_QUEUE}/fal-ai/flux-pro/kontext`, {
    method  : 'POST',
    headers : {
      'Authorization'                  : `Key ${env.FAL_KEY}`,
      'Content-Type'                   : 'application/json',
      'x-fal-webhook-url'              : `${workerUrl}/fal-callback`,
      'X-Fal-Object-Lifecycle-Preference': 'min',
    },
    body: JSON.stringify({
      image_url       : imageUrl,
      prompt          : prompt,
      guidance_scale  : 3.5,
      num_images      : 1,
      output_format   : 'jpeg',
      safety_tolerance: '6',
    }),
  });

  if (!res.ok) throw new Error(`flux-kontext ${res.status}: ${await res.text()}`);
  const q = await res.json();
  console.log('[flux-kontext] queued:', JSON.stringify(q));

  await env.beauty_ai_db
    .prepare(`INSERT INTO pending_jobs (request_id, user_id, bot_token, chat_id, status_url, response_url, salon_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(q.request_id, meta.userId, meta.botToken, meta.chatId, q.status_url, q.response_url, meta.salonId ?? null)
    .run();
}

// ─── Makeup flow (1 photo) ────────────────────────────────────────────────────
async function handleMakeup(fileUrl, salon, user, env, botToken, chatId, userId, maxImages) {
  if (isMonthlyLimitReached(salon)) {
    await sendMessage(botToken, chatId,
      '⏸ Извините, на этот месяц лимит примерок в этом салоне исчерпан. ' +
      'Сервис возобновит работу в начале следующего месяца.'
    );
    return;
  }

  await sendMessage(botToken, chatId,
    '⏳ Отправил задачу на генерацию! Пришлю результат как только будет готово — обычно 30–90 секунд. 💄'
  );
  try {
    await submitFalJob(
      'fal-ai/flux/dev/image-to-image',
      {
        image_url          : fileUrl,
        prompt             : "Apply professional glamorous makeup: flawless foundation, subtle contouring, elegant eyeshadow gradient, voluminous mascara, defined brows, glossy lip color. Keep the person's face and identity exactly the same. Photorealistic, beauty magazine photography, studio lighting.",
        negative_prompt    : 'distorted face, blurry, ugly, unrealistic, cartoon, animated',
        strength           : 0.55,
        num_inference_steps: 28,
        guidance_scale     : 3.5,
        num_images         : 1,
      },
      { userId, botToken, chatId, salonId: salon.id },
      env
    );
    await setState(env, userId, botToken, S.PROCESSING, {});
  } catch (err) {
    console.error('Makeup job submit error:', err);
    await sendMessage(botToken, chatId,
      '❌ Не удалось отправить задачу. Попробуй с другим фото.'
    );
  }
}

// ─── Nails flow (1 photo) ─────────────────────────────────────────────────────
async function handleNails(fileUrl, salon, user, env, botToken, chatId, userId, maxImages) {
  if (isMonthlyLimitReached(salon)) {
    await sendMessage(botToken, chatId,
      '⏸ Извините, на этот месяц лимит примерок в этом салоне исчерпан. ' +
      'Сервис возобновит работу в начале следующего месяца.'
    );
    return;
  }

  await sendMessage(botToken, chatId,
    '⏳ Отправил задачу на генерацию! Пришлю результат как только будет готово — обычно 30–90 секунд. 💅'
  );
  try {
    await submitFalJob(
      'fal-ai/flux-pro/v1/fill',
      {
        image_url          : fileUrl,
        prompt             : 'Trendy nail art: elegant French manicure with subtle geometric patterns and glitter accents, high-gloss gel finish, perfectly shaped nails, professional beauty photography, studio lighting.',
        negative_prompt    : 'broken nails, dirty, uneven, ugly',
        num_inference_steps: 28,
        guidance_scale     : 3.5,
        num_images         : 1,
      },
      { userId, botToken, chatId, salonId: salon.id },
      env
    );
    await setState(env, userId, botToken, S.PROCESSING, {});
  } catch (err) {
    console.error('Nails job submit error:', err);
    await sendMessage(botToken, chatId,
      '❌ Не удалось отправить задачу. Попробуй с другим фото.'
    );
  }
}

// ─── Post-generation: increment counter, check limit ─────────────────────────
async function incrementAndCheckLimit(env, botToken, chatId, salon, user, userId, maxImages, retryText, retryState) {
  const newCount = (user.image_count ?? 0) + 1;
  await env.beauty_ai_db
    .prepare('UPDATE users SET image_count = ? WHERE user_id = ? AND bot_token = ?')
    .bind(newCount, userId, botToken)
    .run();

  // Increment salon-level monthly counter (both new and legacy fields)
  await env.beauty_ai_db
    .prepare(`UPDATE salons
              SET monthly_generations_count = monthly_generations_count + 1,
                  plan_used = plan_used + 1
              WHERE bot_token = ?`)
    .bind(botToken).run();

  // Alert owner if we just hit the monthly cap
  const updated = await env.beauty_ai_db
    .prepare(`SELECT plan_name, max_allowed_generations, plan_limit,
                     monthly_generations_count, plan_used
              FROM salons WHERE bot_token = ?`)
    .bind(botToken).first();
  if (updated) {
    const max  = updated.max_allowed_generations ?? updated.plan_limit  ?? 0;
    const used = updated.monthly_generations_count ?? updated.plan_used ?? 0;
    if (max > 0 && used >= max) {
      const planLabel = updated.plan_name ?? 'тарифа';
      await sendMessage(botToken, salon.admin_chat_id,
        `🚨 *Лимит генераций исчерпан!*\n\n` +
        `Использовано: *${used}/${max}* генераций по ${planLabel}.\n\n` +
        `Ваши клиенты хотят примерить образы, но бот заблокирован.\n` +
        `Срочно докупите пакет или перейдите на более высокий тариф — нажмите *📋 Тариф*`
      );
    }
  }

  if (newCount >= maxImages) {
    // B2B trial owner finishes test-drive → show tariff/package selector
    if (salon.status === 'trial' && String(chatId) === String(salon.admin_chat_id)) {
      await showB2bTariffSelector(botToken, chatId, env);
    } else {
      await sendOfferMessage(botToken, chatId, salon);
    }
    await setState(env, userId, botToken, S.DONE, {});
  } else {
    const remaining = maxImages - newCount;
    await sendMessage(botToken, chatId,
      `${retryText}\n_(Осталось попыток: ${remaining})_`
    );
    await setState(env, userId, botToken, retryState, {});
  }
}

// ─── Offer message with WhatsApp CTA ─────────────────────────────────────────
async function sendOfferMessage(botToken, chatId, salon) {
  const waPhone = salon.whatsapp_phone.replace(/\D/g, '');
  const disc    = salon.discount ?? null;

  let bodyText, buttonText, waText;

  if (disc) {
    waText     = `Здравствуйте! Хочу записаться в ${salon.salon_name} со скидкой ${disc}% — пробовал(а) ИИ-подбор причёски 🎉`;
    buttonText = `🟢 Записаться со скидкой ${disc}%`;
    bodyText   = [
      `🎉 *Примерки закончились!*`,
      '',
      `Нравится какой-то результат? Воплотите его в жизнь!`,
      '',
      `🎁 *Скидка ${disc}% на первый визит* — только для вас от *${salon.salon_name}*`,
      '',
      `👇 Нажмите и запишитесь за 30 секунд:`,
    ].join('\n');
  } else {
    waText     = `Здравствуйте! Хочу записаться в ${salon.salon_name} — пробовал(а) ИИ-подбор причёски, хочу сделать такую же!`;
    buttonText = `💈 Записаться в ${salon.salon_name}`;
    bodyText   = [
      `🎉 *Примерки закончились!*`,
      '',
      `Понравился какой-то вариант? Самое время воплотить его в жизнь!`,
      '',
      `Запишитесь в *${salon.salon_name}* — покажите мастеру понравившееся фото.`,
      '',
      `👇 Записаться за 30 секунд:`,
    ].join('\n');
  }

  const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(waText)}`;
  await sendMessage(botToken, chatId, bodyText, {
    inline_keyboard: [[{ text: buttonText, url: waUrl }]],
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN BOT
//  Route: POST /admin-webhook
//  Secrets needed: ADMIN_BOT_TOKEN, ADMIN_USER_ID
//  Var needed:     WORKER_URL
// ═══════════════════════════════════════════════════════════════════════════════

// Admin conversation states (stored in user_states with bot_token = 'admin')
const A = {
  START              : 'start',
  ADD_TOKEN          : 'add_token',
  ADD_NAME           : 'add_name',
  ADD_PHONE          : 'add_phone',
  ADD_MAX            : 'add_max',
  ADD_DISCOUNT       : 'add_discount',
  BROADCAST_SELECT   : 'broadcast_select',
  BROADCAST_TEXT     : 'broadcast_text',
  CREATE_TRIAL_NAME  : 'create_trial_name',
  CREATE_TRIAL_PHONE : 'create_trial_phone',
  MASS_TRIAL_WAIT    : 'mass_trial_wait',
  SKIP_TRIAL_WAIT    : 'skip_trial_wait',
  ATTACH_BOT_OWNER   : 'attach_bot_owner',
  ATTACH_BOT_TOKEN   : 'attach_bot_token',
  CREATE_TRIAL_TYPE  : 'create_trial_type',
  ADD_ADMIN          : 'add_admin',
  RESET_USER         : 'reset_user',
  UPLOAD_WELCOME     : 'upload_welcome',
  UPLOAD_OFERTA      : 'upload_oferta',
};

async function handleAdminUpdate(update, env) {
  const callbackQuery = update.callback_query;
  const message       = update.message;

  if (callbackQuery) {
    const userId = String(callbackQuery.from.id);
    const chatId = String(callbackQuery.message.chat.id);
    if (!await isAdminId(env, userId)) {
      // Non-admin callback → standard client / owner flow
      await handleStandardUpdate(update, env);
    } else {
      await handleAdminCallback(callbackQuery, env);
    }
    return;
  }
  if (!message) return;

  const userId = String(message.from.id);
  const chatId = String(message.chat.id);

  // Non-admin → standard client / owner flow
  if (!await isAdminId(env, userId)) {
    await handleStandardUpdate(update, env);
    return;
  }

  const stateRow = await env.beauty_ai_db
    .prepare('SELECT * FROM user_states WHERE user_id = ? AND bot_token = ?')
    .bind(userId, 'admin')
    .first();

  const state    = stateRow?.state    ?? A.START;
  const tempData = JSON.parse(stateRow?.temp_data ?? '{}');

  // /start or main menu button always resets to menu
  if (message.text === '/start' || message.text === '🏠 Главное меню') {
    await showAdminMenu(env, chatId);
    await setAdminState(env, userId, A.START, {});
    return;
  }

  // ── Welcome photo upload via state ──────────────────────────────────────────
  if (message.photo && state === A.UPLOAD_WELCOME) {
    const slot  = tempData.slot ?? '1';
    const key   = slot === '2' ? 'welcome_photo_2' : 'welcome_photo_1';
    const fileId = message.photo[message.photo.length - 1].file_id;
    await env.beauty_ai_db
      .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
      .bind(key, fileId).run();
    await setAdminState(env, userId, A.START, {});
    await adminSend(env, chatId,
      `✅ Фото ${slot} сохранено! Клиенты увидят его при первом запуске бота.`
    );
    await showAdminMenu(env, chatId);
    return;
  }

  // Oferta PDF upload
  if (message.document && state === A.UPLOAD_OFERTA) {
    const fileId = message.document.file_id;
    await env.beauty_ai_db
      .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('oferta_pdf', ?, datetime('now'))")
      .bind(fileId).run();
    await setAdminState(env, userId, A.START, {});
    await adminSend(env, chatId, '✅ Оферта сохранена! Клиенты будут получать этот PDF по кнопке в тарифном меню.');
    await showAdminMenu(env, chatId);
    return;
  }

  // /clear_welcome — remove welcome photos
  if (message.text === '/clear_welcome') {
    await env.beauty_ai_db.prepare("DELETE FROM settings WHERE key IN ('welcome_photo_1','welcome_photo_2')").run();
    await adminSend(env, chatId, '✅ Фото-примеры удалены.');
    return;
  }

  // ── Mass-trial tools (always available regardless of state) ──────────────
  if (message.text === '/template') {
    await sendMassTrialTemplate(env, chatId);
    return;
  }

  if (message.text?.startsWith('/create_trial')) {
    await handleCreateTrial(message, env, chatId);
    return;
  }

  // Document upload: either in MASS_TRIAL_WAIT state or with /mass_trial caption
  if (message.document && (
    state === A.MASS_TRIAL_WAIT ||
    (message.caption?.trim() ?? '').startsWith('/mass_trial')
  )) {
    await handleMassTrial(message, env, chatId);
    await setAdminState(env, userId, A.START, {});
    return;
  }

  // Menu buttons always work regardless of current state
  const MENU_BUTTONS = ['📋 Мои боты', '👥 Все клиенты', '📥 Экспорт базы',
    '📢 Рассылка', '➕ Создать триал', '⏭ Скипнуть триал', '📄 Шаблон CSV',
    '📤 Загрузить CSV', '🔗 Привязать бот', '➕ Добавить бота',
    '🖼 Фото приветствия', '🔄 Сбросить клиента', '🏠 Главное меню'];
  if (MENU_BUTTONS.includes(message.text)) {
    await handleAdminMenuAction(message.text, env, chatId, userId);
    return;
  }

  switch (state) {
    case A.START:
      await handleAdminMenuAction(message.text, env, chatId, userId);
      break;

    case A.ADD_TOKEN:
      await setAdminState(env, userId, A.ADD_NAME, { bot_token: message.text.trim() });
      await adminSend(env, chatId, '2️⃣ Введи *название салона*:\n_(например: Barber Shop Almaty)_');
      break;

    case A.ADD_NAME:
      // Type is always barber — skip type selection
      await setAdminState(env, userId, A.ADD_PHONE, { ...tempData, salon_name: message.text.trim(), salon_type: 'barber' });
      await adminSend(env, chatId, '3️⃣ Введи *WhatsApp-номер* салона (только цифры):\n_(например: `77001112233`)_');
      break;

    case A.ADD_PHONE:
      await setAdminState(env, userId, A.ADD_MAX, { ...tempData, whatsapp_phone: message.text.trim() });
      await adminSend(env, chatId,
        '4️⃣ Сколько *бесплатных генераций* даём клиенту?\n_(введи число, например: `3`)_'
      );
      break;

    case A.ADD_MAX: {
      const maxImages = Math.max(1, parseInt(message.text) || 3);
      await setAdminState(env, userId, A.ADD_DISCOUNT, { ...tempData, max_images: maxImages });
      await adminSend(env, chatId, '5️⃣ Скидка для клиентов через бота?', discountKeyboard('a'));
      break;
    }

    case A.ADD_DISCOUNT:
      await adminSend(env, chatId, '👆 Выбери скидку:', discountKeyboard('a'));
      break;

    case A.BROADCAST_SELECT:
      await startBroadcast(env, chatId, userId);
      break;

    case A.BROADCAST_TEXT:
      await sendBroadcast(env, chatId, userId, message.text, tempData.broadcast_target);
      break;

    case A.CREATE_TRIAL_NAME: {
      const name = message.text?.trim();
      if (!name) { await adminSend(env, chatId, '✍️ Введи название салона:'); break; }
      await setAdminState(env, userId, A.CREATE_TRIAL_TYPE, { trial_name: name });
      await adminSend(env, chatId,
        `✅ *${name}*\n\n🏷️ Выберите тип заведения:`,
        salonTypeKeyboard('trial_type')
      );
      break;
    }

    case A.CREATE_TRIAL_TYPE: {
      await adminSend(env, chatId, '👆 Выберите тип заведения:', salonTypeKeyboard('trial_type'));
      break;
    }

    case A.CREATE_TRIAL_PHONE: {
      const phone = message.text?.replace(/\D/g, '') ?? '';
      if (phone.length < 10) {
        await adminSend(env, chatId, '❌ Неверный номер. Только цифры, минимум 10.');
        break;
      }
      try {
        const salonType = tempData.trial_type ?? 'barber';
        const salon = await createTrialSalon(env, tempData.trial_name, phone, 'admin_create', null, salonType);
        const botUsername = env.STANDARD_BOT_USERNAME ?? 'qrbeatyai_bot';
        const link = `https://t.me/${botUsername}?start=${salon.slug}`;
        await setAdminState(env, userId, A.START, {});
        const typeEmoji = { barber: '✂️', makeup: '💄', nails: '💅' };
        await adminSend(env, chatId,
          `✅ *Триал создан!*\n\n${typeEmoji[salonType] ?? '🤖'} *${salon.name}*\n📱 WhatsApp: \`${phone}\`\n🔗 Ссылка для оунера:\n\`${link}\`\n\n_Когда оунер откроет ссылку, его Telegram ID автоматически привяжется._`
        );
        await showAdminMenu(env, chatId);
      } catch (err) {
        console.error('[create_trial]', err);
        await adminSend(env, chatId, `❌ Ошибка: \`${err.message}\``);
        await setAdminState(env, userId, A.START, {});
      }
      break;
    }

    case A.MASS_TRIAL_WAIT:
      await adminSend(env, chatId, '📎 Пришли CSV-файл (без подписи — просто файлом).');
      break;

    case A.ATTACH_BOT_OWNER: {
      const ownerId = (message.text ?? '').trim().replace(/\D/g, '');
      if (!ownerId) {
        await adminSend(env, chatId, '❌ Введи числовой Telegram ID владельца:');
        break;
      }
      const salon = await env.beauty_ai_db
        .prepare('SELECT id, name, salon_name FROM salons WHERE admin_chat_id = ?')
        .bind(ownerId).first();
      if (!salon) {
        await adminSend(env, chatId,
          `❌ Салон с ID \`${ownerId}\` не найден.\n\nВладелец должен сначала открыть свою ссылку.`
        );
        await setAdminState(env, userId, A.START, {});
        break;
      }
      await setAdminState(env, userId, A.ATTACH_BOT_TOKEN, { attach_owner_id: ownerId, attach_salon_id: salon.id, attach_salon_name: salon.name ?? salon.salon_name });
      await adminSend(env, chatId,
        `✅ Салон: *${salon.name ?? salon.salon_name}*\n\n` +
        `Теперь введи *токен бота* который нужно подключить:\n_(получить у @BotFather → /mybots → выбрать бота → API Token)_`
      );
      break;
    }

    case A.ATTACH_BOT_TOKEN: {
      const newToken = (message.text ?? '').trim();
      if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(newToken)) {
        await adminSend(env, chatId, '❌ Неверный формат токена. Попробуй ещё раз:');
        break;
      }
      await setAdminState(env, userId, A.START, {});
      await attachPremiumBot(env, chatId, tempData.attach_owner_id, tempData.attach_salon_id, tempData.attach_salon_name, newToken);
      await showAdminMenu(env, chatId);
      break;
    }

    case A.RESET_USER: {
      const targetId = (message.text ?? '').trim().replace(/\D/g, '');
      if (!targetId) {
        await adminSend(env, chatId, '❌ Неверный формат. Введи числовой Telegram ID:');
        break;
      }
      await env.beauty_ai_db
        .prepare('DELETE FROM user_states WHERE user_id = ?')
        .bind(targetId).run();
      await env.beauty_ai_db
        .prepare('UPDATE users SET image_count = 0, phone = NULL WHERE user_id = ?')
        .bind(targetId).run();
      await setAdminState(env, userId, A.START, {});
      await adminSend(env, chatId,
        `✅ Пользователь \`${targetId}\` сброшен.\n\n` +
        `• Счётчик примерок обнулён\n` +
        `• Состояние очищено\n\n` +
        `Теперь он может начать заново через свою ссылку.`
      );
      await showAdminMenu(env, chatId);
      break;
    }

    case A.ADD_ADMIN: {
      const newAdminId = (message.text ?? '').trim().replace(/\D/g, '');
      if (!newAdminId) {
        await adminSend(env, chatId, '❌ Неверный формат. Введи числовой Telegram ID:');
        break;
      }
      if (getPrimaryAdminIds(env).includes(newAdminId)) {
        await adminSend(env, chatId, 'ℹ️ Этот ID уже является главным администратором.');
        await setAdminState(env, userId, A.START, {});
        await showAdminsList(env, chatId);
        break;
      }
      await env.beauty_ai_db
        .prepare('INSERT OR IGNORE INTO admins (user_id) VALUES (?)')
        .bind(newAdminId).run();
      await setAdminState(env, userId, A.START, {});
      await adminSend(env, chatId, `✅ Администратор \`${newAdminId}\` добавлен.`);
      await showAdminsList(env, chatId);
      break;
    }

    case A.SKIP_TRIAL_WAIT: {
      const targetId = (message.text ?? '').trim().replace(/\D/g, '');
      if (!targetId) {
        await adminSend(env, chatId, '❌ Введи числовой Telegram ID владельца:');
        break;
      }
      const botToken = env.STANDARD_BOT_TOKEN;
      const salon = await env.beauty_ai_db
        .prepare('SELECT * FROM salons WHERE admin_chat_id = ?')
        .bind(targetId).first();
      if (!salon) {
        await adminSend(env, chatId,
          `❌ Салон с ID \`${targetId}\` не найден.\n\nВладелец должен сначала открыть свою ссылку (пройти онбординг).`
        );
        await setAdminState(env, userId, A.START, {});
        break;
      }
      const maxImages = salon.max_images ?? 3;
      await env.beauty_ai_db
        .prepare('UPDATE users SET image_count = ? WHERE user_id = ? AND bot_token = ?')
        .bind(maxImages, targetId, botToken).run();
      await setState(env, targetId, botToken, S.DONE, {});
      await showB2bTariffSelector(botToken, targetId, env);
      await setAdminState(env, userId, A.START, {});
      await adminSend(env, chatId,
        `✅ Триал пропущен для \`${targetId}\`.\n\n*${salon.name ?? salon.salon_name}* — им отправлен выбор тарифа.`
      );
      await showAdminMenu(env, chatId);
      break;
    }
  }
}

// ─── Admin: /template — send CSV template file ───────────────────────────────

async function sendMassTrialTemplate(env, chatId) {
  const csv = [
    'Название;Телефон;Источник',
    'ChopChop Almaty;77012345678;Inst_Almaty',
    'OldBoy Astana;77079876543;2GIS_Astana',
  ].join('\n');

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document',
    new File([new Blob([csv], { type: 'text/csv' })], 'trial_template.csv', { type: 'text/csv' }),
    'trial_template.csv'
  );
  form.append('caption',
    'Шаблон для массовой генерации триалов.\n\n' +
    'Заполните строки по аналогии, сохраните как CSV и отправьте мне с подписью /mass_trial'
  );

  await fetch(`${TELEGRAM_API}/bot${env.ADMIN_BOT_TOKEN}/sendDocument`, {
    method: 'POST', body: form,
  });
}

// ─── Admin: /mass_trial — parse CSV, create trials, return results ────────────

async function handleMassTrial(message, env, chatId) {
  const fileId  = message.document.file_id;
  const fileUrl = await getTelegramFileUrl(env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN, fileId);
  const raw     = await (await fetch(fileUrl)).text();

  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    await adminSend(env, chatId, '❌ Файл пустой или неверный формат.');
    return;
  }

  const total = lines.length - 1;
  await adminSend(env, chatId, `⏳ Обрабатываю ${total} строк…`);
  console.log(`[mass_trial] start: ${total} rows`);

  const botUsername = env.STANDARD_BOT_USERNAME ?? 'YourBot';

  // 1. Parse all valid rows in memory
  let skipped = 0;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    if (parts.length < 2) { skipped++; continue; }
    const [name, phone, source] = parts.map(p => p.trim());
    if (!name || !phone) { skipped++; continue; }
    rows.push({ name, phone: phone.replace(/\D/g, ''), source: source || 'mass_trial' });
  }

  // 2. Generate slugs in memory — deduplicate within the batch
  const usedSlugs = new Set();
  for (const row of rows) {
    let slug;
    for (let attempt = 0; attempt < 20; attempt++) {
      slug = generateSlug(row.name);
      if (!usedSlugs.has(slug)) break;
    }
    usedSlugs.add(slug);
    row.slug = slug;
    row.token = 'trial:' + slug;
  }

  console.log(`[mass_trial] parsed: ${rows.length} valid rows, ${skipped} skipped`);

  // 3. Batch INSERT — parallel chunks of 100 statements, INSERT OR IGNORE handles rare slug collisions
  const INSERT_CHUNK = 100;
  const insertChunks = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) insertChunks.push(rows.slice(i, i + INSERT_CHUNK));
  await Promise.all(insertChunks.map(chunk =>
    env.beauty_ai_db.batch(chunk.map(row =>
      env.beauty_ai_db
        .prepare(`INSERT OR IGNORE INTO salons
          (slug, bot_token, status, name, salon_name, salon_type,
           whatsapp_phone, admin_chat_id, max_images, max_allowed_generations,
           monthly_generations_count, source_track)
          VALUES (?, ?, 'trial', ?, ?, 'barber', ?, '0', 3, 3, 0, ?)`)
        .bind(row.slug, row.token, row.name, row.name, row.phone, row.source)
    ))
  ));

  console.log(`[mass_trial] inserts done`);
  // 5. Build result CSV with ready WhatsApp script per row
  const resultRows = ['Название;Телефон;Ссылка;Скрипт WhatsApp'];
  for (const row of rows) {
    const link   = `https://t.me/${botUsername}?start=${row.slug}`;
    const script = `${row.name}, компания Beauty AI.\n\nНашли способ, как салоны в Казахстане получают новых клиентов без таргета и без сторис.\n\nКлиент видит себя с готовой причёской на своём фото — прямо в телефоне. Сам выбирает стиль, сам принимает решение. Вы получаете человека, который уже определился и готов записаться.\n\nИспытайте это на себе прямо сейчас — в нашем бесплатном демо-режиме:\n👉 ${link}`;
    resultRows.push(`${row.name};${row.phone};${link};"${script.replace(/"/g, '""')}"`);
  }

  const resultCsv = '﻿' + resultRows.join('\n');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document',
    new File([new Blob([resultCsv], { type: 'text/csv' })], 'trial_results.csv', { type: 'text/csv' }),
    'trial_results.csv'
  );
  form.append('caption', `✅ Создано: *${rows.length}*, пропущено: *${skipped}*`);
  form.append('parse_mode', 'Markdown');

  await fetch(`${TELEGRAM_API}/bot${env.ADMIN_BOT_TOKEN}/sendDocument`, {
    method: 'POST', body: form,
  });
}

// ─── Admin: /create_trial Name Phone — create single trial ────────────────────

async function handleCreateTrial(message, env, chatId) {
  const args  = message.text.slice('/create_trial'.length).trim();
  const parts = args.split(/\s+/);

  if (parts.length < 2 || !args) {
    await adminSend(env, chatId,
      '❌ Формат: `/create_trial ChopChop Almaty 77012345678`\n\n' +
      '_Последнее слово — номер, остальное — название_'
    );
    return;
  }

  const phone = parts[parts.length - 1].replace(/\D/g, '');
  const name  = parts.slice(0, -1).join(' ');

  if (phone.length < 10) {
    await adminSend(env, chatId, '❌ Неверный номер. Только цифры, минимум 10.');
    return;
  }

  const salon = await createTrialSalon(env, name, phone, 'admin_create');
  const botUsername = env.STANDARD_BOT_USERNAME ?? 'YourBot';
  const link  = `https://t.me/${botUsername}?start=${salon.slug}`;

  await adminSend(env, chatId,
    `✅ *Триал создан!*\n\n` +
    `✂️ *${name}*\n` +
    `📱 WhatsApp: \`${phone}\`\n` +
    `🔗 Ссылка для оунера:\n\`${link}\`\n\n` +
    `_Когда оунер откроет ссылку, его Telegram ID автоматически привяжется._`
  );
}

async function handleAdminCallback(cq, env) {
  const userId = String(cq.from.id);
  const chatId = String(cq.message.chat.id);
  const data   = cq.data;

  // Acknowledge the tap so Telegram removes the spinner
  await fetch(`${TELEGRAM_API}/bot${env.ADMIN_BOT_TOKEN}/answerCallbackQuery`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ callback_query_id: cq.id }),
  });

  if (!await isAdminId(env, userId)) return;

  const stateRow = await env.beauty_ai_db
    .prepare('SELECT * FROM user_states WHERE user_id = ? AND bot_token = ?')
    .bind(userId, 'admin')
    .first();
  const tempData = JSON.parse(stateRow?.temp_data ?? '{}');

  // Discount selected during add-bot flow
  if (data.startsWith('adisc_')) {
    const discount = parseInt(data.replace('adisc_', '')) || null;
    await finishAddBot(env, chatId, userId, { ...tempData, discount });
    return;
  }

  // "Clients of salon X" button
  if (data.startsWith('clients_')) {
    const botToken = data.replace('clients_', '');
    await showClientsBySalon(env, chatId, botToken);
    return;
  }

  // "Info about salon X" button
  if (data.startsWith('info_')) {
    const botToken = data.replace('info_', '');
    await showSalonInfo(env, chatId, botToken);
    return;
  }

  // Welcome photo upload
  if (data === 'upload_welcome_1' || data === 'upload_welcome_2') {
    const slot = data === 'upload_welcome_2' ? '2' : '1';
    await setAdminState(env, userId, A.UPLOAD_WELCOME, { slot });
    await adminSend(env, chatId,
      `📷 Пришли фото ${slot} (пример до/после).\n\n_Просто отправь картинку — без подписи._`
    );
    return;
  }

  if (data === 'delete_welcome') {
    await env.beauty_ai_db
      .prepare("DELETE FROM settings WHERE key IN ('welcome_photo_1','welcome_photo_2')")
      .run();
    await adminSend(env, chatId, '✅ Фото приветствия удалены.');
    return;
  }

  // Delete salon bot — ask confirmation
  if (data.startsWith('del_ask_')) {
    const botToken = data.replace('del_ask_', '');
    const salon = await env.beauty_ai_db
      .prepare('SELECT salon_name FROM salons WHERE bot_token = ?')
      .bind(botToken).first();
    if (!salon) { await adminSend(env, chatId, '❌ Бот не найден.'); return; }
    await adminSend(env, chatId,
      `🗑 *Удалить бот «${salon.salon_name}»?*\n\nБудут удалены:\n• Данные салона\n• Все клиенты и их история\n• Вебхук бота\n\nВладелец получит уведомление.`,
      { inline_keyboard: [
        [{ text: '✅ Да, удалить', callback_data: `del_go_${botToken}` }],
        [{ text: '❌ Отмена',      callback_data: 'del_cancel' }],
      ]}
    );
    return;
  }

  // Delete salon bot — confirmed
  if (data.startsWith('del_go_')) {
    const botToken = data.replace('del_go_', '');
    await deleteSalon(env, botToken, chatId);
    return;
  }

  if (data === 'del_cancel') {
    await adminSend(env, chatId, '✅ Удаление отменено.');
    return;
  }

  // B2B payment confirm / reject / launch  (format: pok:<uid>:<pkg>, pno:<uid>, pla:<uid>)
  if (data.startsWith('pok:')) {
    await confirmB2bPayment(env, chatId, data);
    return;
  }
  if (data.startsWith('pno:')) {
    await rejectB2bPayment(env, chatId, data);
    return;
  }
  if (data.startsWith('pla:')) {
    await launchB2bPremiumBot(env, chatId, data);
    return;
  }

  // Admin trial type selection
  if (data.startsWith('trial_type_')) {
    const salonType = data.replace('trial_type_', '');
    const typeNames = { barber: 'Барбершоп / Стрижки', makeup: 'Макияж / Студия красоты', nails: 'Ногти / Маникюр' };
    await setAdminState(env, userId, A.CREATE_TRIAL_PHONE, { ...tempData, trial_type: salonType });
    await adminSend(env, chatId,
      `✅ Тип: *${typeNames[salonType] ?? salonType}*\n\n📱 Введи WhatsApp-номер (только цифры):\n_Например: 77001112233_`
    );
    return;
  }

  // Tariff assignment
  if (data.startsWith('asgn_')) {
    const parts     = data.split('_');
    const salonId   = parts[1];
    const tariffKey = parts[2];
    await assignTariff(env, salonId, tariffKey, chatId);
    return;
  }

  // Application approval / rejection
  if (data.startsWith('approve_')) {
    await approveApplication(env, chatId, parseInt(data.replace('approve_', '')));
    return;
  }
  if (data.startsWith('reject_')) {
    await rejectApplication(env, chatId, parseInt(data.replace('reject_', '')));
    return;
  }

  // Broadcast target selected
  if (data.startsWith('bcast_')) {
    const target = data.replace('bcast_', '');
    let targetLabel;
    let audienceNote;
    if (target === 'ALL') {
      targetLabel = 'все клиенты';
      audienceNote = 'всем клиентам, поделившимся контактом';
    } else if (target === 'owners') {
      targetLabel = 'все владельцы';
      audienceNote = 'всем владельцам салонов';
    } else if (target.startsWith('sid_')) {
      const salonId = target.replace('sid_', '');
      const sln = await env.beauty_ai_db
        .prepare('SELECT salon_name FROM salons WHERE id = ?')
        .bind(salonId).first();
      targetLabel = sln?.salon_name ?? 'салон';
      audienceNote = `клиентам салона *${targetLabel}*, поделившимся контактом`;
    } else {
      targetLabel = 'бот';
      audienceNote = 'клиентам';
    }
    await setAdminState(env, userId, A.BROADCAST_TEXT, { broadcast_target: target });
    await adminSend(env, chatId,
      `✍️ *Рассылка — ${targetLabel}*\n\nНапиши текст сообщения.\n\n_Он будет отправлен ${audienceNote}._`
    );
    return;
  }

  // ── Admin management ────────────────────────────────────────────────────────
  if (data === 'admin_add') {
    await setAdminState(env, userId, A.ADD_ADMIN, {});
    await adminSend(env, chatId,
      '👮 *Добавить администратора*\n\n' +
      'Введи *Telegram ID* нового администратора.\n\n' +
      '_Как узнать ID: попроси человека написать @userinfobot_'
    );
    return;
  }

  if (data.startsWith('admin_rm_')) {
    const targetId = data.replace('admin_rm_', '');
    if (getPrimaryAdminIds(env).includes(targetId)) {
      await adminSend(env, chatId, '❌ Нельзя удалить главного администратора.');
      return;
    }
    await env.beauty_ai_db.prepare('DELETE FROM admins WHERE user_id = ?').bind(targetId).run();
    await adminSend(env, chatId, `✅ Администратор \`${targetId}\` удалён.`);
    await showAdminsList(env, chatId);
    return;
  }
}

// ── Admin menu ────────────────────────────────────────────────────────────────

async function attachPremiumBot(env, adminChatId, ownerId, salonId, salonName, newToken) {
  const stdToken = env.STANDARD_BOT_TOKEN;

  // Validate token via Telegram API
  const meResp = await fetch(`${TELEGRAM_API}/bot${newToken}/getMe`);
  const meData = await meResp.json();
  if (!meData.ok) {
    await adminSend(env, adminChatId, `❌ Токен недействителен: ${meData.description}`);
    return;
  }
  const botUsername = meData.result.username;

  // Check token not already used
  const conflict = await env.beauty_ai_db
    .prepare('SELECT id FROM salons WHERE bot_token = ?').bind(newToken).first();
  if (conflict) {
    await adminSend(env, adminChatId, `❌ Этот токен уже используется другим салоном.`);
    return;
  }

  // Register webhook
  const workerUrl  = env.WORKER_URL.replace(/\/$/, '');
  const webhookUrl = `${workerUrl}/webhook/${encodeURIComponent(newToken)}`;
  await fetch(`${TELEGRAM_API}/bot${newToken}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] }),
  });

  // Update salon bot_token to the real premium token
  await env.beauty_ai_db
    .prepare('UPDATE salons SET bot_token = ? WHERE id = ?')
    .bind(newToken, salonId).run();

  // Reset owner state and notify them
  await setState(env, ownerId, stdToken, 'start', {});
  const botLink = `https://t.me/${botUsername}`;
  await sendMessage(stdToken, ownerId,
    `🚀 *Ваш личный бот подключён!*\n\n` +
    `Бот: @${botUsername}\n\n` +
    `🔗 Ссылка для клиентов:\n\`${botLink}\`\n\n` +
    `Поделитесь ею с клиентами — они сразу попадут к вашему боту.`,
    ownerMenuKeyboard()
  );

  await adminSend(env, adminChatId,
    `✅ Бот @${botUsername} привязан к *${salonName}*!\n\nВладелец \`${ownerId}\` уведомлён.`
  );
}

async function showAdminsList(env, chatId) {
  const primaryIds = getPrimaryAdminIds(env);
  const { results: dbAdmins } = await env.beauty_ai_db
    .prepare('SELECT user_id, added_at FROM admins ORDER BY added_at')
    .all();

  let text = '👮 *Администраторы панели*\n\n';
  text += primaryIds.map(id => `• \`${id}\` — главный _(из настроек)_`).join('\n');
  if (dbAdmins.length) {
    text += '\n' + dbAdmins.map(a => `• \`${a.user_id}\` — помощник`).join('\n');
  }

  const removeButtons = dbAdmins.map(a => [{
    text: `🗑 Удалить ${a.user_id}`,
    callback_data: `admin_rm_${a.user_id}`,
  }]);

  await adminSend(env, chatId, text, {
    inline_keyboard: [
      [{ text: '➕ Добавить администратора', callback_data: 'admin_add' }],
      ...removeButtons,
    ],
  });
}

async function showAdminStats(env, chatId) {
  const [totalSalons, activeSalons, trialSalons, totalClients, gensRow] = await Promise.all([
    env.beauty_ai_db.prepare("SELECT COUNT(*) AS cnt FROM salons").first(),
    env.beauty_ai_db.prepare("SELECT COUNT(*) AS cnt FROM salons WHERE status IN ('standard_active','premium_active')").first(),
    env.beauty_ai_db.prepare("SELECT COUNT(*) AS cnt FROM salons WHERE status = 'trial'").first(),
    env.beauty_ai_db.prepare("SELECT COUNT(DISTINCT user_id) AS cnt FROM users").first(),
    env.beauty_ai_db.prepare("SELECT SUM(monthly_generations_count) AS total FROM salons").first(),
  ]);

  const totalGens = gensRow?.total ?? 0;
  const costUsd   = (totalGens * 0.04).toFixed(2);

  const { results: top } = await env.beauty_ai_db
    .prepare(`SELECT salon_name, monthly_generations_count FROM salons
              WHERE monthly_generations_count > 0
              ORDER BY monthly_generations_count DESC LIMIT 5`)
    .all();

  const topLines = top.map(s => `• ${s.salon_name}: *${s.monthly_generations_count}* ген.`).join('\n');

  await adminSend(env, chatId,
    `📊 *Общая статистика Beauty AI*\n\n` +
    `🏢 Всего салонов: *${totalSalons?.cnt ?? 0}*\n` +
    `   ✅ Активных: *${activeSalons?.cnt ?? 0}*\n` +
    `   🔬 Триалов: *${trialSalons?.cnt ?? 0}*\n\n` +
    `👥 Всего клиентов: *${totalClients?.cnt ?? 0}*\n\n` +
    `🎨 Генераций этот месяц: *${totalGens}*\n` +
    `💰 Расход fal.ai: *~$${costUsd}*\n` +
    (topLines ? `\n📈 *Топ-5 по генерациям:*\n${topLines}` : '')
  );
}

async function showAdminMenu(env, chatId) {
  await adminSend(env, chatId,
    '🤖 *Панель управления Beauty AI*\n\nВыбери действие:',
    {
      keyboard: [
        ['📋 Мои боты', '👥 Все клиенты'],
        ['📥 Экспорт базы', '📢 Рассылка'],
        ['➕ Создать триал', '⏭ Скипнуть триал'],
        ['📄 Шаблон CSV', '📤 Загрузить CSV'],
        ['🔗 Привязать бот', '➕ Добавить бота'],
        ['📊 Общая статистика', '👮 Администраторы'],
        ['🖼 Фото приветствия', '🔄 Сбросить клиента'],
        ['📋 Загрузить оферту', '🏠 Главное меню'],
      ],
      resize_keyboard: true,
    }
  );
}

async function handleAdminMenuAction(text, env, chatId, userId) {
  if (text === '📋 Мои боты') {
    await showSalons(env, chatId);
  } else if (text === '👥 Все клиенты') {
    await showAllClients(env, chatId);
  } else if (text === '📥 Экспорт базы') {
    await exportClients(env, chatId);
  } else if (text === '📢 Рассылка') {
    await startBroadcast(env, chatId, userId);
  } else if (text === '➕ Создать триал') {
    await setAdminState(env, userId, A.CREATE_TRIAL_NAME, {});
    await adminSend(env, chatId, '✍️ Введи *название* барбершопа или салона:');
  } else if (text === '⏭ Скипнуть триал') {
    await setAdminState(env, userId, A.SKIP_TRIAL_WAIT, {});
    await adminSend(env, chatId,
      '⏭ *Пропустить триал владельца*\n\nВведи *Telegram ID* владельца салона:\n\n_Как узнать ID: попроси владельца написать боту `/start` и перешли мне его сообщение, или используй @userinfobot_'
    );
  } else if (text === '📄 Шаблон CSV') {
    await sendMassTrialTemplate(env, chatId);
  } else if (text === '📤 Загрузить CSV') {
    await setAdminState(env, userId, A.MASS_TRIAL_WAIT, {});
    await adminSend(env, chatId,
      '📎 Пришли CSV-файл со списком салонов.\n\n_Формат: Название;Телефон;Источник_\n_Нужен шаблон? Нажми *📄 Шаблон CSV*_'
    );
  } else if (text === '📊 Общая статистика') {
    await showAdminStats(env, chatId);
  } else if (text === '👮 Администраторы') {
    await showAdminsList(env, chatId);
  } else if (text === '📋 Загрузить оферту') {
    await setAdminState(env, userId, A.UPLOAD_OFERTA, {});
    await adminSend(env, chatId,
      '📋 *Загрузка оферты*\n\n' +
      'Пришли PDF-файл оферты — клиенты будут получать его по кнопке в тарифном меню.\n\n' +
      '_Как получить PDF: открой_ `https://beauty-ai-saas.artbycube8.workers.dev/oferta` _в браузере → Cmd+P → Сохранить как PDF_'
    );
  } else if (text === '🖼 Фото приветствия') {
    await adminSend(env, chatId,
      '🖼 *Фото приветствия*\n\nЭти фото показываются клиентам при первом запуске бота (примеры до/после).\n\nКакое фото загрузить?',
      { inline_keyboard: [
        [{ text: '📷 Фото 1', callback_data: 'upload_welcome_1' },
         { text: '📷 Фото 2', callback_data: 'upload_welcome_2' }],
        [{ text: '🗑 Удалить оба', callback_data: 'delete_welcome' }],
      ]}
    );
  } else if (text === '🔄 Сбросить клиента') {
    await setAdminState(env, userId, A.RESET_USER, {});
    await adminSend(env, chatId,
      '🔄 *Сброс клиента*\n\nВведи *Telegram ID* пользователя.\n\n' +
      '_Это обнулит его счётчик примерок и сбросит состояние — он сможет начать заново._\n\n' +
      '_Как узнать ID: @userinfobot_'
    );
  } else if (text === '🔗 Привязать бот') {
    await setAdminState(env, userId, A.ATTACH_BOT_OWNER, {});
    await adminSend(env, chatId,
      '🔗 *Привязать Premium-бот к салону*\n\n' +
      'Введи *Telegram ID* владельца салона\n_(кому подключаем бота)_:'
    );
  } else if (text === '➕ Добавить бота') {
    await setAdminState(env, userId, A.ADD_TOKEN, {});
    await adminSend(env, chatId,
      '➕ *Добавление нового бота*\n\n' +
      '1️⃣ Создай бота у @BotFather и введи сюда его *токен*:\n_(вида `1234567890:AAHxx...`)_'
    );
  } else {
    await showAdminMenu(env, chatId);
  }
}

// ── List salons ───────────────────────────────────────────────────────────────

async function showSalons(env, chatId) {
  const { results } = await env.beauty_ai_db
    .prepare(`
      SELECT s.bot_token, s.salon_name, s.salon_type, s.max_images,
             s.status, s.plan_name, s.paid_until,
             s.monthly_generations_count, s.max_allowed_generations,
             COUNT(u.id) AS client_count
      FROM salons s
      LEFT JOIN users u ON u.bot_token = s.bot_token AND u.phone IS NOT NULL
      GROUP BY s.bot_token
      ORDER BY s.created_at DESC
    `)
    .all();

  if (!results.length) {
    await adminSend(env, chatId, 'У тебя пока нет ботов. Нажми *➕ Добавить бота*.');
    return;
  }

  const emoji   = { barber: '✂️', makeup: '💄', nails: '💅' };
  const statusLabel = { trial: '🧪 Триал', standard_active: '✅ Активна', premium_active: '✅ Активна', expired: '❌ Истекла' };

  let text = `📋 *Твои боты (${results.length}):*\n\n`;
  const buttons = [];

  for (const s of results) {
    const used  = s.monthly_generations_count ?? 0;
    const limit = s.max_allowed_generations   ?? 0;
    const status = statusLabel[s.status] ?? s.status;
    const planLine = s.plan_name
      ? `${status} · ${s.plan_name} · ${used}/${limit} ген.`
      : status;
    const paidLine = s.paid_until ? ` · до ${s.paid_until}` : '';

    text += `${emoji[s.salon_type] ?? '🤖'} *${s.salon_name}*\n`;
    text += `   ${planLine}${paidLine} · 👥 ${s.client_count}\n\n`;

    buttons.push([
      { text: `👥 Клиенты`,  callback_data: `clients_${s.bot_token}` },
      { text: `ℹ️ Инфо`,    callback_data: `info_${s.bot_token}`    },
      { text: `🗑 Удалить`, callback_data: `del_ask_${s.bot_token}` },
    ]);
  }

  await adminSend(env, chatId, text, { inline_keyboard: buttons });
}

async function showSalonInfo(env, chatId, botToken) {
  const s = await env.beauty_ai_db
    .prepare('SELECT * FROM salons WHERE bot_token = ?')
    .bind(botToken).first();
  if (!s) { await adminSend(env, chatId, '❌ Салон не найден.'); return; }

  const clientCount = await env.beauty_ai_db
    .prepare('SELECT COUNT(*) as cnt FROM users WHERE bot_token = ? AND phone IS NOT NULL')
    .bind(botToken).first();

  const emoji      = { barber: '✂️', makeup: '💄', nails: '💅' };
  const statusLabel = { trial: '🧪 Триал', standard_active: '✅ Активна', premium_active: '✅ Активна', expired: '❌ Истекла' };

  const used  = s.monthly_generations_count ?? 0;
  const limit = s.max_allowed_generations   ?? 0;
  const falCostUsed  = (used  * 0.04).toFixed(2);
  const falCostLimit = (limit * 0.04).toFixed(2);

  let text = `${emoji[s.salon_type] ?? '🤖'} *${s.salon_name}* — подробно\n\n`;
  text += `📋 Статус: ${statusLabel[s.status] ?? s.status}\n`;
  if (s.plan_name) text += `📦 Тариф: *${s.plan_name}*\n`;
  if (s.paid_until) text += `📅 Оплачено до: *${s.paid_until}*\n`;
  if (limit > 0) {
    text += `📊 Генераций: *${used} / ${limit}* в этом месяце\n`;
    text += `💰 Расходы fal.ai: ~$${falCostUsed} из $${falCostLimit}\n`;
  }
  text += `🎯 Примерок на клиента: *${s.max_images ?? 3}*\n`;
  text += `👥 Клиентов: *${clientCount?.cnt ?? 0}*\n`;
  text += `📱 WhatsApp: \`${s.whatsapp_phone ?? '—'}\`\n`;
  if (s.slug) {
    const stdUsername = s.standard_bot_username ?? 'qrbeatyai_bot';
    text += `🔗 Ссылка клиентов: \`https://t.me/qrbeatyai_bot?start=${s.slug}\`\n`;
  }

  await adminSend(env, chatId, text);
}

// ── List clients ──────────────────────────────────────────────────────────────

async function showAllClients(env, chatId) {
  const { results } = await env.beauty_ai_db
    .prepare(`
      SELECT u.name, u.phone, u.image_count, u.created_at,
             s.salon_name, s.salon_type
      FROM users u
      JOIN salons s ON s.bot_token = u.bot_token
      WHERE u.phone IS NOT NULL
      ORDER BY u.created_at DESC
      LIMIT 50
    `)
    .all();

  if (!results.length) {
    await adminSend(env, chatId, 'Клиентов пока нет.');
    return;
  }

  const emoji = { barber: '✂️', makeup: '💄', nails: '💅' };
  let text = `👥 *Все клиенты — последние ${results.length}:*\n\n`;

  for (const c of results) {
    text += `${emoji[c.salon_type] ?? '🤖'} *${c.name ?? 'Без имени'}*\n`;
    text += `   📱 \`${c.phone}\`  |  ${c.salon_name}  |  Генераций: ${c.image_count}\n\n`;
  }

  // Telegram limits message length to 4096 chars; split if needed
  if (text.length > 4000) {
    text = text.slice(0, 4000) + '\n\n_...и другие. Смотри по конкретному боту._';
  }

  await adminSend(env, chatId, text);
}

async function showClientsBySalon(env, chatId, botToken) {
  const salon = await env.beauty_ai_db
    .prepare('SELECT * FROM salons WHERE bot_token = ?')
    .bind(botToken)
    .first();

  const { results } = await env.beauty_ai_db
    .prepare(`
      SELECT name, phone, image_count, created_at
      FROM users
      WHERE bot_token = ? AND phone IS NOT NULL
      ORDER BY created_at DESC
    `)
    .bind(botToken)
    .all();

  if (!results.length) {
    await adminSend(env, chatId, `В боте *${salon?.salon_name ?? botToken}* пока нет клиентов.`);
    return;
  }

  let text = `👥 *Клиенты — ${salon?.salon_name} (${results.length}):*\n\n`;
  for (const c of results) {
    text += `👤 *${c.name ?? 'Без имени'}*\n`;
    text += `   📱 \`${c.phone}\`  |  Генераций: ${c.image_count}\n\n`;
  }

  if (text.length > 4000) text = text.slice(0, 4000) + '\n\n_...показаны не все_';
  await adminSend(env, chatId, text);
}

// ── Finish add-bot flow ───────────────────────────────────────────────────────

async function finishAddBot(env, chatId, userId, data) {
  try {
    await env.beauty_ai_db
      .prepare(`
        INSERT INTO salons (bot_token, salon_name, salon_type, whatsapp_phone, admin_chat_id, max_images, discount)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(data.bot_token, data.salon_name, data.salon_type,
            data.whatsapp_phone, chatId, data.max_images, data.discount ?? null)
      .run();

    // Auto-register webhook so the new bot is live immediately
    const workerUrl   = env.WORKER_URL.replace(/\/$/, '');
    const webhookUrl  = `${workerUrl}/webhook/${encodeURIComponent(data.bot_token)}`;
    const whRes       = await fetch(`${TELEGRAM_API}/bot${data.bot_token}/setWebhook`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ url: webhookUrl }),
    });
    const whData      = await whRes.json();
    const webhookLine = whData.ok
      ? '✅ Вебхук установлен автоматически'
      : `⚠️ Вебхук: ${whData.description}`;

    const emoji = { barber: '✂️', makeup: '💄', nails: '💅' };
    await adminSend(env, chatId,
      `✅ *Бот успешно добавлен!*\n\n` +
      `${emoji[data.salon_type] ?? '🤖'} *${data.salon_name}*\n` +
      `Тип: \`${data.salon_type}\`\n` +
      `📱 WhatsApp: \`${data.whatsapp_phone}\`\n` +
      `🎁 Бесплатных генераций: ${data.max_images}\n` +
      `🔗 ${webhookLine}\n\n` +
      `Напиши боту \`/start\` и проверь!`
    );
  } catch (err) {
    console.error('finishAddBot error:', err);
    await adminSend(env, chatId,
      `❌ Ошибка при сохранении: \`${err.message}\`\n\nПопробуй ещё раз — нажми *➕ Добавить бота*.`
    );
  }

  await setAdminState(env, userId, A.START, {});
  await showAdminMenu(env, chatId);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SALON OWNER REGISTRATION FLOW (non-admin users of the admin bot)
// ═══════════════════════════════════════════════════════════════════════════════

// Video tutorial URL — update when you have a link
const TUTORIAL_VIDEO_URL = 'https://youtube.com';

function generateBotNames(salonName) {
  const displayName = salonName.trim() + ' AI';
  const slug = salonName.trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const username = (slug || 'my_salon') + '_ai_bot';
  return { displayName, username };
}

async function setBotPhoto(botToken, blob) {
  const form = new FormData();
  form.append('photo', new File([blob], 'logo.jpg', { type: 'image/jpeg' }), 'logo.jpg');
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/setMyPhoto`, {
    method: 'POST',
    body  : form,
  });
  if (!res.ok) console.warn('[setBotPhoto] failed:', await res.text());
  return res.ok;
}

async function handleRegMessage(message, env, userId, chatId) {
  const stateRow = await env.beauty_ai_db
    .prepare('SELECT * FROM user_states WHERE user_id = ? AND bot_token = ?')
    .bind(userId, 'reg').first();
  const state    = stateRow?.state ?? 'reg_start';
  const tempData = JSON.parse(stateRow?.temp_data ?? '{}');

  const supportLink = env?.SUPPORT_TG_LINK ?? 'https://t.me/BeautyAI_Support';
  await adminSend(env, chatId,
    `🤖 *Beauty AI*\n\nЭтот бот для авторизованных пользователей.\n\n` +
    `Если вы владелец салона — зайдите по вашей пригласительной ссылке.\n\n` +
    `По вопросам: ${supportLink}`
  );
  return;

  // ── Photo input: logo step ──
  if (message.photo && state === 'reg_photo') {
    const photo   = message.photo[message.photo.length - 1];
    const fileUrl = await getTelegramFileUrl(env.ADMIN_BOT_TOKEN, photo.file_id);
    const imgRes  = await fetch(fileUrl);
    const blob    = await imgRes.blob();

    const ok = await setBotPhoto(tempData.bot_token, blob);
    if (!ok) {
      await adminSend(env, chatId,
        '⚠️ Не удалось установить фото автоматически — установите его вручную через BotFather.\n\nПродолжаем...'
      );
    } else {
      await adminSend(env, chatId, '✅ Логотип установлен как фото бота!');
    }

    await setRegState(env, userId, 'reg_phone', { ...tempData, salon_type: 'barber' });
    await adminSend(env, chatId,
      '3️⃣ Введите *WhatsApp-номер* салона (только цифры):\n_(например: `77001112233`)_'
    );
    return;
  }

  if (!message.text) return;

  switch (state) {
    case 'reg_salon_name': {
      const rawName = message.text.trim();
      if (!/[a-zA-Z]/.test(rawName)) {
        await adminSend(env, chatId,
          '❌ Введите название *на английском языке*.\n\nПример: `Barber Shop Almaty` или `Beauty Studio Astana`'
        );
        return;
      }
      const { displayName, username } = generateBotNames(rawName);
      await setRegState(env, userId, 'reg_token', { salon_name: rawName, display_name: displayName, bot_username: username });
      await adminSend(env, chatId,
        `✅ Готово! Вот данные для создания бота в @BotFather:\n\n` +
        `*Название бота* — скопируйте и вставьте:\n\`${displayName}\`\n\n` +
        `*Username бота* — скопируйте и вставьте:\n\`${username}\`\n\n` +
        `📌 *Как создать:*\n` +
        `1. Откройте @BotFather\n` +
        `2. Отправьте /newbot\n` +
        `3. Вставьте название: \`${displayName}\`\n` +
        `4. Вставьте username: \`${username}\`\n` +
        `5. Скопируйте токен и отправьте сюда\n\n` +
        `_Если username занят — добавьте цифру в конце, например \`${username.replace('_bot', '2_bot')}\`_`,
        { inline_keyboard: [
          [{ text: '📖 Инструкция', callback_data: 'show_instruction' }, { text: '▶️ Видео', url: TUTORIAL_VIDEO_URL }],
        ]}
      );
      break;
    }

    case 'reg_token': {
      const token = message.text.trim();
      if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(token)) {
        await adminSend(env, chatId,
          '❌ Неверный формат токена.\nОн должен выглядеть так:\n`1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxx`\n\nПопробуйте ещё раз:'
        );
        return;
      }
      const exists = await env.beauty_ai_db
        .prepare('SELECT id FROM salons WHERE bot_token = ?').bind(token).first();
      if (exists) {
        await adminSend(env, chatId, '⚠️ Этот бот уже подключён к системе.');
        return;
      }
      await setRegState(env, userId, 'reg_photo', { ...tempData, bot_token: token });
      await adminSend(env, chatId,
        '2️⃣ Отправьте *логотип* вашего салона 📸\n\n_Мы автоматически установим его как фото бота_'
      );
      break;
    }

    case 'reg_photo':
      await adminSend(env, chatId, '📸 Пришлите фото — логотип или фото вашего салона.');
      break;

    case 'reg_phone': {
      const phone = message.text.trim().replace(/\D/g, '');
      if (phone.length < 10) {
        await adminSend(env, chatId, '❌ Введите корректный номер (только цифры, минимум 10 знаков).\nПример: `77001112233`');
        return;
      }
      await setRegState(env, userId, 'reg_max', { ...tempData, whatsapp_phone: phone });
      await adminSend(env, chatId,
        '4️⃣ Сколько *бесплатных генераций* давать каждому клиенту?',
        { inline_keyboard: [
          [{ text: '3 (рекомендуем)', callback_data: 'rmax_3' }],
          [{ text: '5', callback_data: 'rmax_5' }, { text: '10', callback_data: 'rmax_10' }],
        ]}
      );
      break;
    }
    case 'reg_max': {
      const max = Math.max(1, parseInt(message.text) || 3);
      await setRegState(env, userId, 'reg_discount', { ...tempData, max_images: max });
      await adminSend(env, chatId, '5️⃣ Хотите давать *скидку* клиентам через бота?', discountKeyboard('r'));
      break;
    }
    case 'reg_discount':
      await adminSend(env, chatId, '👆 Выберите скидку:', discountKeyboard('r'));
      break;
    case 'reg_pending':
      await adminSend(env, chatId, '⏳ Ваша заявка уже на рассмотрении. Уведомим о решении здесь.');
      break;
    default:
      await adminSend(env, chatId,
        '👆 Нажмите кнопку чтобы начать:',
        { inline_keyboard: [[{ text: '🚀 Подать заявку', callback_data: 'reg_start' }]] }
      );
  }
}

async function handleRegCallback(cq, env, userId, chatId) {
  const data     = cq.data;
  const stateRow = await env.beauty_ai_db
    .prepare('SELECT * FROM user_states WHERE user_id = ? AND bot_token = ?')
    .bind(userId, 'reg').first();
  const tempData = JSON.parse(stateRow?.temp_data ?? '{}');

  if (data === 'show_instruction') {
    await sendInstruction(env, chatId);
    return;
  }
  if (data === 'reg_start') {
    await setRegState(env, userId, 'reg_salon_name', {});
    await adminSend(env, chatId,
      '1️⃣ Введите *название вашего барбершопа или салона* на английском языке:\n\n' +
      '_Например: `Barber Shop Almaty` или `Beauty Studio Astana`_'
    );
    return;
  }
  if (data.startsWith('rmax_')) {
    const max = parseInt(data.replace('rmax_', '')) || 3;
    await setRegState(env, userId, 'reg_discount', { ...tempData, max_images: max });
    await adminSend(env, chatId, '6️⃣ Хотите давать *скидку* клиентам, которые воспользовались ботом?', discountKeyboard('r'));
    return;
  }
  if (data.startsWith('rdisc_')) {
    const discount = parseInt(data.replace('rdisc_', '')) || null;
    await submitApplication(env, chatId, userId, { ...tempData, discount });
    return;
  }
}

async function submitApplication(env, chatId, userId, data) {
  // Check for duplicate pending application
  const dup = await env.beauty_ai_db
    .prepare('SELECT id FROM pending_applications WHERE bot_token = ?').bind(data.bot_token).first();
  if (dup) {
    await adminSend(env, chatId, '⚠️ Заявка с этим токеном уже ожидает рассмотрения.');
    return;
  }

  const result = await env.beauty_ai_db
    .prepare(`INSERT INTO pending_applications
              (applicant_chat_id, bot_token, salon_name, salon_type, whatsapp_phone, max_images, discount)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(chatId, data.bot_token, data.salon_name, data.salon_type, data.whatsapp_phone, data.max_images, data.discount ?? null)
    .run();
  const appId = result.meta.last_row_id;

  const emoji     = { barber: '✂️', makeup: '💄', nails: '💅' };
  const typeNames = { barber: 'Барбершоп', makeup: 'Макияж', nails: 'Маникюр' };

  // Notify admin with approve/reject buttons (token masked for security)
  await adminSend(env, String(env.ADMIN_USER_ID),
    `🔔 *Новая заявка #${appId}*\n\n` +
    `${emoji[data.salon_type] ?? '🤖'} *${data.salon_name}*\n` +
    `📂 Тип: ${typeNames[data.salon_type] ?? data.salon_type}\n` +
    `📱 WhatsApp: \`${data.whatsapp_phone}\`\n` +
    `🎁 Лимит: ${data.max_images} генерации\n` +
    `💰 Скидка: ${data.discount ? data.discount + '%' : 'не предусмотрена'}\n` +
    `🔑 Токен: \`${maskToken(data.bot_token)}\`\n` +
    `👤 Chat ID заявителя: \`${chatId}\``,
    { inline_keyboard: [[
      { text: '✅ Подтвердить', callback_data: `approve_${appId}` },
      { text: '❌ Отклонить',  callback_data: `reject_${appId}`  },
    ]]},
  );

  // Confirm to applicant
  await setRegState(env, userId, 'reg_pending', {});
  await adminSend(env, chatId,
    `✅ *Заявка #${appId} отправлена на рассмотрение!*\n\n` +
    `${emoji[data.salon_type] ?? '🤖'} *${data.salon_name}*\n` +
    `📱 WhatsApp: \`${data.whatsapp_phone}\`\n` +
    `🎁 Лимит: ${data.max_images} генерации\n\n` +
    `⏳ Уведомим вас о решении в этом чате.`
  );
}

async function approveApplication(env, adminChatId, appId) {
  const app = await env.beauty_ai_db
    .prepare('SELECT * FROM pending_applications WHERE id = ?').bind(appId).first();
  if (!app) {
    await adminSend(env, adminChatId, '❌ Заявка не найдена (возможно, уже обработана).');
    return;
  }

  try {
    await env.beauty_ai_db
      .prepare(`INSERT INTO salons (bot_token, salon_name, salon_type, whatsapp_phone, admin_chat_id, max_images, discount)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(app.bot_token, app.salon_name, app.salon_type, app.whatsapp_phone, app.applicant_chat_id, app.max_images, app.discount ?? null)
      .run();

    const workerUrl  = env.WORKER_URL.replace(/\/$/, '');
    const webhookUrl = `${workerUrl}/webhook/${encodeURIComponent(app.bot_token)}`;
    const whRes      = await fetch(`${TELEGRAM_API}/bot${app.bot_token}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const whData     = await whRes.json();

    await env.beauty_ai_db
      .prepare('DELETE FROM pending_applications WHERE id = ?').bind(appId).run();

    const emoji     = { barber: '✂️', makeup: '💄', nails: '💅' };
    const typeNames = { barber: 'Барбершоп', makeup: 'Макияж', nails: 'Маникюр' };

    // Get bot username for a direct link
    const botUsername = await getBotUsername(app.bot_token);

    // Build inline keyboard for applicant
    const appButtons = [[{ text: '📖 Инструкция по настройке', callback_data: 'show_instruction' }]];
    if (botUsername) {
      appButtons.push([{ text: `🤖 Открыть @${botUsername}`, url: `https://t.me/${botUsername}` }]);
    }

    const botLink = botUsername
      ? `Перейдите в [@${botUsername}](https://t.me/${botUsername}) и напишите \`/start\` чтобы проверить.`
      : `Перейдите в @BotFather, найдите вашего бота и напишите ему \`/start\` чтобы проверить.`;

    // Notify applicant
    await adminSend(env, app.applicant_chat_id,
      `🎉 *Ваша заявка одобрена!*\n\n` +
      `${emoji[app.salon_type] ?? '🤖'} Бот *${app.salon_name}* подключён и готов к работе!\n\n` +
      botLink,
      { inline_keyboard: appButtons }
    );
    await setRegState(env, app.applicant_chat_id, 'reg_start', {});

    await adminSend(env, adminChatId,
      `✅ *Заявка #${appId} одобрена*\n` +
      `${emoji[app.salon_type] ?? '🤖'} ${app.salon_name} (${typeNames[app.salon_type]})\n` +
      `${whData.ok ? 'Вебхук установлен.' : `Вебхук: ${whData.description}`}`
    );
  } catch (err) {
    console.error('approveApplication error:', err);
    await adminSend(env, adminChatId, `❌ Ошибка при одобрении: \`${err.message}\``);
  }
}

async function rejectApplication(env, adminChatId, appId) {
  const app = await env.beauty_ai_db
    .prepare('SELECT * FROM pending_applications WHERE id = ?').bind(appId).first();
  if (!app) {
    await adminSend(env, adminChatId, '❌ Заявка не найдена.');
    return;
  }

  await env.beauty_ai_db
    .prepare('DELETE FROM pending_applications WHERE id = ?').bind(appId).run();

  const emoji = { barber: '✂️', makeup: '💄', nails: '💅' };
  await adminSend(env, app.applicant_chat_id,
    `❌ *Ваша заявка отклонена.*\n\n` +
    `К сожалению, заявка на подключение бота *${app.salon_name}* была отклонена.\n\n` +
    `Если считаете это ошибкой — свяжитесь с администратором.`
  );
  await setRegState(env, app.applicant_chat_id, 'reg_start', {});

  await adminSend(env, adminChatId,
    `❌ Заявка #${appId} отклонена: ${emoji[app.salon_type] ?? '🤖'} ${app.salon_name}`
  );
}

// Masks the secret part of a bot token: 123456:ABCdef...xyz → 123456:ABC***xyz
function maskToken(token) {
  const idx = token.indexOf(':');
  if (idx === -1) return '***';
  const id  = token.slice(0, idx);
  const key = token.slice(idx + 1);
  if (key.length <= 8) return `${id}:***`;
  return `${id}:${key.slice(0, 3)}${'*'.repeat(key.length - 6)}${key.slice(-3)}`;
}

// Gets the @username of a bot via getMe API
async function getBotUsername(token) {
  try {
    const res  = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    const data = await res.json();
    return data.ok ? data.result.username : null;
  } catch { return null; }
}

async function sendInstruction(env, chatId) {
  await adminSend(env, chatId,
    `📖 *Инструкция — создание бота в BotFather*\n\n` +

    `*Шаг 1: Создайте бота*\n` +
    `1. Откройте @BotFather в Telegram\n` +
    `2. Отправьте /newbot\n` +
    `3. Вставьте *название* — наш бот уже сгенерировал его для вас\n` +
    `4. Вставьте *username* — наш бот тоже его сгенерировал\n` +
    `5. Скопируйте токен из ответа BotFather\n\n` +

    `*Шаг 2: Вставьте токен*\n` +
    `Вернитесь в этот бот и отправьте токен\n\n` +

    `*Шаг 3: Логотип*\n` +
    `Отправьте фото — бот сам установит его автоматически ✅\n\n` +

    `💡 *Правило username:*\n` +
    `Только латиница, цифры и \`_\`, в конце \`_bot\`\n` +
    `Если username занят — добавьте цифру: \`salon_ai_2_bot\``,
    { inline_keyboard: [[{ text: '▶️ Смотреть видео-инструкцию', url: TUTORIAL_VIDEO_URL }]] }
  );
}

async function setRegState(env, userId, state, tempData) {
  await env.beauty_ai_db
    .prepare(`INSERT INTO user_states (user_id, bot_token, state, temp_data, updated_at)
              VALUES (?, 'reg', ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(user_id, bot_token) DO UPDATE SET
                state = excluded.state, temp_data = excluded.temp_data, updated_at = CURRENT_TIMESTAMP`)
    .bind(userId, state, JSON.stringify(tempData))
    .run();
}

// ── Export clients as CSV document ────────────────────────────────────────────

async function deleteSalon(env, botToken, adminChatId) {
  const salon = await env.beauty_ai_db
    .prepare('SELECT * FROM salons WHERE bot_token = ?')
    .bind(botToken).first();
  if (!salon) { await adminSend(env, adminChatId, '❌ Бот не найден.'); return; }

  // Remove Telegram webhook
  await fetch(`${TELEGRAM_API}/bot${botToken}/deleteWebhook`).catch(() => {});

  // Notify salon owner before deleting data
  await sendMessage(botToken, salon.admin_chat_id,
    `⚠️ Ваш бот *${salon.salon_name}* был отключён от платформы Beauty AI.\n\nЕсли это ошибка — свяжитесь с администратором.`
  ).catch(() => {});

  // Delete all related data
  await env.beauty_ai_db.prepare('DELETE FROM users       WHERE bot_token = ?').bind(botToken).run();
  await env.beauty_ai_db.prepare('DELETE FROM user_states WHERE bot_token = ?').bind(botToken).run();
  await env.beauty_ai_db.prepare('DELETE FROM pending_jobs WHERE bot_token = ?').bind(botToken).run();
  await env.beauty_ai_db.prepare('DELETE FROM pending_applications WHERE bot_token = ?').bind(botToken).run();
  await env.beauty_ai_db.prepare('DELETE FROM salons       WHERE bot_token = ?').bind(botToken).run();

  await adminSend(env, adminChatId,
    `✅ Бот *${salon.salon_name}* удалён. Владелец уведомлён.`
  );
}

async function exportClients(env, chatId) {
  const { results } = await env.beauty_ai_db
    .prepare(`
      SELECT u.name, u.phone, u.image_count, u.created_at,
             s.salon_name, s.salon_type
      FROM users u
      JOIN salons s ON s.bot_token = u.bot_token
      WHERE u.phone IS NOT NULL
      ORDER BY s.salon_name, u.created_at DESC
    `)
    .all();

  if (!results.length) {
    await adminSend(env, chatId, '📭 Клиентов с телефонами пока нет.');
    return;
  }

  const emoji = { barber: '✂️', makeup: '💄', nails: '💅' };
  const lines = ['Имя;Телефон;Генераций;Салон;Тип;Дата'];
  for (const c of results) {
    const date = (c.created_at ?? '').replace('T', ' ').slice(0, 16);
    lines.push(`${c.name ?? ''};${c.phone};${c.image_count};${c.salon_name};${emoji[c.salon_type] ?? c.salon_type};${date}`);
  }
  const csv = '﻿' + lines.join('\n'); // BOM for correct Excel UTF-8 opening

  const date = new Date().toISOString().slice(0, 10);
  await sendAdminDocument(env, chatId, `clients_${date}.csv`, csv,
    `📊 База клиентов — ${results.length} чел. | ${date}`
  );
}

// ── Broadcast: show salon selector ────────────────────────────────────────────

async function startBroadcast(env, chatId, userId) {
  const { results: salons } = await env.beauty_ai_db
    .prepare('SELECT id, bot_token, salon_name, salon_type FROM salons ORDER BY salon_name')
    .all();

  if (!salons.length) {
    await adminSend(env, chatId, 'У тебя нет ботов для рассылки. Сначала добавь бота.');
    return;
  }

  const emoji = { barber: '✂️', makeup: '💄', nails: '💅' };
  const buttons = [
    [{ text: '📢 Все клиенты (все боты)', callback_data: 'bcast_ALL' }],
    [{ text: '👑 Всем владельцам салонов',  callback_data: 'bcast_owners' }],
    ...salons.map(s => [{ text: `${emoji[s.salon_type] ?? '🤖'} ${s.salon_name}`, callback_data: `bcast_sid_${s.id}` }]),
  ];

  await adminSend(env, chatId,
    '📢 *Рассылка*\n\nКому отправить сообщение?',
    { inline_keyboard: buttons }
  );
  await setAdminState(env, userId, A.BROADCAST_SELECT, {});
}

// ── Broadcast: send message to all clients of target bot(s) ──────────────────

async function sendBroadcast(env, chatId, userId, text, target) {
  if (!text?.trim()) {
    await adminSend(env, chatId, '⚠️ Пустое сообщение. Напиши текст для рассылки:');
    return;
  }

  // recipients: array of { chat_id, token }
  let recipients = [];

  if (target === 'owners') {
    // Send to all salon owners via their own bot
    const { results: salonRows } = await env.beauty_ai_db
      .prepare(`SELECT admin_chat_id, bot_token FROM salons
                WHERE admin_chat_id IS NOT NULL AND admin_chat_id != '' AND admin_chat_id != '0'`)
      .all();
    recipients = salonRows.map(s => ({
      chat_id: s.admin_chat_id,
      token: isValidTgToken(s.bot_token) ? s.bot_token : env.STANDARD_BOT_TOKEN,
    }));
  } else if (target.startsWith('sid_')) {
    const salonId = target.replace('sid_', '');
    const { results: userRows } = await env.beauty_ai_db
      .prepare('SELECT user_id, bot_token FROM users WHERE phone IS NOT NULL AND salon_id = ?')
      .bind(salonId).all();
    recipients = userRows.map(u => ({ chat_id: u.user_id, token: u.bot_token }));
  } else if (target === 'ALL') {
    const { results: userRows } = await env.beauty_ai_db
      .prepare('SELECT user_id, bot_token FROM users WHERE phone IS NOT NULL')
      .all();
    recipients = userRows.map(u => ({ chat_id: u.user_id, token: u.bot_token }));
  }

  if (!recipients.length) {
    const emptyMsg = target === 'owners'
      ? '📭 Нет владельцев (ни один салон не зарегистрирован с admin_chat_id).'
      : '📭 Нет клиентов для рассылки (никто не поделился контактом).';
    await adminSend(env, chatId, emptyMsg);
    await setAdminState(env, userId, A.START, {});
    await showAdminMenu(env, chatId);
    return;
  }

  await adminSend(env, chatId, `⏳ Отправляю ${recipients.length} сообщений…`);

  let sent = 0, failed = 0;
  const BATCH = 25;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const batch = recipients.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(r => sendMessage(r.token, r.chat_id, text))
    );
    sent   += results.filter(r => r.status === 'fulfilled').length;
    failed += results.filter(r => r.status === 'rejected').length;
  }

  await adminSend(env, chatId,
    `✅ *Рассылка завершена!*\n\n📤 Отправлено: *${sent}*\n❌ Не доставлено: *${failed}*\n_(Недоставленные — заблокировавшие бота)_`
  );
  await setAdminState(env, userId, A.START, {});
  await showAdminMenu(env, chatId);
}

// ── Admin helpers ─────────────────────────────────────────────────────────────

async function sendAdminDocument(env, chatId, filename, content, caption = '') {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', new Blob([content], { type: 'text/csv; charset=utf-8' }), filename);
  if (caption) form.append('caption', caption);

  const token = env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN;
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) console.error(`sendDocument error: ${res.status} ${await res.text()}`);
}

async function adminSend(env, chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const token = env.ADMIN_BOT_TOKEN ?? env.STANDARD_BOT_TOKEN;
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(body),
  });
  if (!res.ok) console.error(`adminSend error: ${res.status} ${await res.text()}`);
}

async function setAdminState(env, userId, state, tempData) {
  await env.beauty_ai_db
    .prepare(`
      INSERT INTO user_states (user_id, bot_token, state, temp_data, updated_at)
      VALUES (?, 'admin', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, bot_token) DO UPDATE SET
        state      = excluded.state,
        temp_data  = excluded.temp_data,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(userId, state, JSON.stringify(tempData))
    .run();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FAL.AI ASYNC QUEUE
//  Flow: submitFalJob → fal.ai processes → POST /fal-callback → send to user
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Submit a job to fal.ai queue with a webhook so we get called back when done.
 * Stores the job in pending_jobs so handleFalCallback can find the user.
 */
async function submitFalJob(model, input, meta, env) {
  const workerUrl = env.WORKER_URL.replace(/\/$/, '');

  const res = await fetch(`${FAL_QUEUE}/${model}`, {
    method  : 'POST',
    headers : {
      'Authorization' : `Key ${env.FAL_KEY}`,
      'Content-Type'  : 'application/json',
      'x-fal-webhook-url' : `${workerUrl}/fal-callback`,
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) throw new Error(`fal queue ${res.status}: ${await res.text()}`);
  const q = await res.json();
  console.log('[submitFalJob] queued:', JSON.stringify(q));

  await env.beauty_ai_db
    .prepare(`INSERT INTO pending_jobs (request_id, user_id, bot_token, chat_id, status_url, response_url, salon_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(q.request_id, meta.userId, meta.botToken, meta.chatId, q.status_url, q.response_url, meta.salonId ?? null)
    .run();
}

/**
 * Called by fal.ai when a queued job finishes.
 * Finds the pending job, sends the result image to the user, updates limits.
 */
async function handleFalCallback(body, env) {
  console.log('[fal-callback] received:', JSON.stringify(body).slice(0, 500));
  const requestId = body.request_id;
  if (!requestId) { console.log('[fal-callback] no request_id, ignoring'); return; }

  // fal.ai sends status "OK" on success, "ERROR" on failure
  if (body.status === 'ERROR') {
    console.error('fal.ai job error:', JSON.stringify(body.error));
    // Try to notify user
    const job = await env.beauty_ai_db
      .prepare('SELECT * FROM pending_jobs WHERE request_id = ?')
      .bind(requestId).first();
    if (job) {
      await sendMessage(job.bot_token, job.chat_id,
        '❌ ИИ не смог обработать фото. Попробуй с другим изображением — более чёткое и хорошо освещённое.'
      );
      await env.beauty_ai_db
        .prepare('DELETE FROM pending_jobs WHERE request_id = ?')
        .bind(requestId).run();
      // Reset state
      const salon = await env.beauty_ai_db
        .prepare('SELECT salon_type FROM salons WHERE bot_token = ?')
        .bind(job.bot_token).first();
      const resetState = { barber: S.WAITING_SELFIE, makeup: S.WAITING_FACE, nails: S.WAITING_HAND };
      await setState(env, job.user_id, job.bot_token, resetState[salon?.salon_type] ?? S.WAITING_SELFIE, {});
    }
    return;
  }

  if (body.status !== 'OK') return; // IN_QUEUE / IN_PROGRESS — ignore

  // Extract image URL — fal.ai wraps result in `payload`
  const output   = body.payload ?? body.output ?? body;
  const imageUrl = output.image?.url ?? output.images?.[0]?.url;
  if (!imageUrl) { console.error('No image URL in fal callback:', JSON.stringify(body)); return; }

  // Look up the pending job
  const job = await env.beauty_ai_db
    .prepare('SELECT * FROM pending_jobs WHERE request_id = ?')
    .bind(requestId).first();
  if (!job) return;

  await env.beauty_ai_db
    .prepare('DELETE FROM pending_jobs WHERE request_id = ?')
    .bind(requestId).run();

  const salon = await env.beauty_ai_db
    .prepare('SELECT * FROM salons WHERE bot_token = ?')
    .bind(job.bot_token).first();
  const user = await env.beauty_ai_db
    .prepare('SELECT * FROM users WHERE user_id = ? AND bot_token = ?')
    .bind(job.user_id, job.bot_token).first();

  if (!salon || !user) return;

  const resultLine  = {
    barber: '🎉 Вот ваша новая причёска!',
    makeup: '🎉 Вот ваш новый образ!',
    nails : '🎉 Вот ваш новый маникюр!',
  };
  const retryTexts  = {
    barber : `✂️ Хотите примерить другую причёску? Пришлите новое *СЕЛФИ*!`,
    makeup : `💄 Хотите примерить другой образ? Пришлите новое *ФОТО*!`,
    nails  : `💅 Хотите попробовать другой дизайн? Пришлите новое *ФОТО рук*!`,
  };
  const retryStates = { barber: S.WAITING_SELFIE, makeup: S.WAITING_FACE, nails: S.WAITING_HAND };

  const discCaption = salon.discount
    ? `💡 Нравится? Запишись в *${salon.salon_name}* со скидкой ${salon.discount}%!`
    : `💡 Нравится? Запишись в *${salon.salon_name}*!`;
  await sendPhotoFile(salon.bot_token, job.chat_id, imageUrl,
    `${resultLine[salon.salon_type] ?? '🎉 Готово!'}\n\n${discCaption}`,
    env.FAL_KEY
  );

  // Delete from fal.ai immediately after delivery — user photos stay private
  await deleteFalPayload(job.request_id, env.FAL_KEY);

  await incrementAndCheckLimit(
    env, salon.bot_token, job.chat_id, salon, user, job.user_id, salon.max_images,
    retryTexts[salon.salon_type]  ?? '🔄 Попробуй ещё раз!',
    retryStates[salon.salon_type] ?? S.WAITING_SELFIE
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TELEGRAM HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getTelegramFileUrl(botToken, fileId) {
  const res  = await fetch(`${TELEGRAM_API}/bot${botToken}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`getFile failed: ${JSON.stringify(data)}`);
  return `${TELEGRAM_API}/file/bot${botToken}/${data.result.file_path}`;
}

async function sendMessage(botToken, chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method  : 'POST',
    headers : { 'Content-Type': 'application/json' },
    body    : JSON.stringify(body),
  });

  if (!res.ok) console.error(`sendMessage error: ${res.status} ${await res.text()}`);
}

async function sendPhoto(botToken, chatId, photoUrl, caption = '', replyMarkup = null) {
  const body = { chat_id: chatId, photo: photoUrl, caption, parse_mode: 'Markdown' };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, {
    method  : 'POST',
    headers : { 'Content-Type': 'application/json' },
    body    : JSON.stringify(body),
  });

  if (!res.ok) console.error(`sendPhoto error: ${res.status} ${await res.text()}`);
}

// Downloads image from fal.ai and uploads directly to Telegram as a file.
// This keeps the fal.ai URL inside the Worker — never exposed to end users.
async function sendPhotoFile(botToken, chatId, falImageUrl, caption = '', falKey) {
  try {
    const imgRes = await fetch(falImageUrl, {
      headers: { 'Authorization': `Key ${falKey}` },
    });
    if (!imgRes.ok) throw new Error(`download ${imgRes.status}`);
    const blob = await imgRes.blob();

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', new File([blob], 'result.jpg', { type: 'image/jpeg' }), 'result.jpg');
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'Markdown');
    }

    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) console.error(`sendPhotoFile error: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error('sendPhotoFile failed, falling back to URL:', err.message);
    await sendPhoto(botToken, chatId, falImageUrl, caption);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STATE MANAGEMENT (D1 upsert)
// ═══════════════════════════════════════════════════════════════════════════════

async function setState(env, userId, botToken, state, tempData) {
  await env.beauty_ai_db
    .prepare(`
      INSERT INTO user_states (user_id, bot_token, state, temp_data, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, bot_token) DO UPDATE SET
        state      = excluded.state,
        temp_data  = excluded.temp_data,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(userId, botToken, state, JSON.stringify(tempData))
    .run();
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

// prefix: 'r' for registration flow, 'a' for admin add-bot flow
function discountKeyboard(prefix) {
  return { inline_keyboard: [
    [
      { text: '💰 5%',  callback_data: `${prefix}disc_5`  },
      { text: '💰 10%', callback_data: `${prefix}disc_10` },
      { text: '💰 15%', callback_data: `${prefix}disc_15` },
    ],
    [{ text: '🚫 Без скидки', callback_data: `${prefix}disc_0` }],
  ]};
}

function contactKeyboard() {
  return {
    keyboard: [[{
      text            : '📱 Поделиться контактом',
      request_contact : true,
    }]],
    resize_keyboard   : true,
    one_time_keyboard : true,
  };
}

function genderKeyboard() {
  return { inline_keyboard: [[
    { text: '👨 Мужские', callback_data: 'gender_male' },
    { text: '👩 Женские', callback_data: 'gender_female' },
  ]]};
}

function maleStylesKeyboard() {
  const m = (key) => ({ text: MALE_STYLES[key].label, callback_data: `mstyle_${key}` });
  return { inline_keyboard: [
    [m('default')],
    // Короткие
    [m('buzz'),        m('crewcut')],
    [m('caesar'),      m('fade')],
    [m('taper'),       m('frenchcrop')],
    [m('edgar'),       m('fauxhawk')],
    // Укладки
    [m('slickback'),   m('undercut')],
    [m('quiff'),       m('pompadour')],
    // Средняя длина
    [m('twoblock'),    m('curtainmen')],
    [m('mullet'),      m('longback')],
    // Кудри
    [m('curlyshort'),  m('curlymed')],
    [m('curlylong')],
  ]};
}

function femaleStylesKeyboard() {
  const f = (key) => ({ text: FEMALE_STYLES[key].label, callback_data: `fstyle_${key}` });
  return { inline_keyboard: [
    [f('default')],
    // Короткие
    [f('pixie'),        f('frenchbob')],
    // Каре
    [f('bob'),          f('angledBob')],
    [f('lob'),          f('curtainbangs')],
    // Средняя длина
    [f('shag'),         f('wolfcut')],
    [f('butterfly'),    f('beachwaves')],
    // Длинные
    [f('longstraight'), f('layers')],
    [f('bluntlong'),    f('curlylong')],
    [f('curlymed')],
    // Укладки
    [f('ponytail'),     f('bun')],
    [f('braid')],
  ]};
}

function colorKeyboard() {
  return { inline_keyboard: [
    [{ text: HAIR_COLORS.skip.label,      callback_data: 'color_skip'      }],
    [{ text: HAIR_COLORS.black.label,     callback_data: 'color_black'     }, { text: HAIR_COLORS.darkbrown.label, callback_data: 'color_darkbrown' }],
    [{ text: HAIR_COLORS.brown.label,     callback_data: 'color_brown'     }, { text: HAIR_COLORS.blonde.label,    callback_data: 'color_blonde'    }],
    [{ text: HAIR_COLORS.ashblonde.label, callback_data: 'color_ashblonde' }, { text: HAIR_COLORS.red.label,       callback_data: 'color_red'       }],
  ]};
}
