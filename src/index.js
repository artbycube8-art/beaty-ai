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
  // B2B owner onboarding (inside Standard bot)
  B2B_NAME  : 'b2b_name',
  B2B_PHONE : 'b2b_phone',
};

// ─── Subscription tariffs ─────────────────────────────────────────────────────
const TARIFFS = {
  start: { name: 'Старт',   limit: 150,  price: 9900  },
  basic: { name: 'Базовый', limit: 300,  price: 14900 },
  pro:   { name: 'Про',     limit: 600,  price: 24900 },
  max:   { name: 'Макс',    limit: 1200, price: 39900 },
};

const FAL_QUEUE = 'https://queue.fal.run';

// ─── Barber presets — FLUX Kontext editing instructions ──────────────────────
// Face smoothing added to every prompt via FACE_FINISH suffix.
const FACE_FINISH = ' Smooth skin with subtle professional retouching, clean natural complexion. Keep the same person face identity, facial features, skin tone, eyes, eyebrows, expression, clothing and background exactly the same — only change the hair. Do NOT alter, recolor, or remove the eyebrows.';

const MALE_STYLES = {
  default    : { label: '✅ Свою причёску',    hairPrompt: "Keep the person's exact current hairstyle completely unchanged — same haircut, same length, same style. Only apply color changes if specified." },
  fade       : { label: '🔪 Фейд',            hairPrompt: "COMPLETELY TRANSFORM the hairstyle into a bald fade. The sides and back MUST be shaved to skin at the bottom, gradually blending upward into 3-5cm of textured hair on top. Sharp temple and neckline lineup. If hair is currently long, shorten it dramatically — the result must look like a fresh barbershop fade. Preserve the man's face, eyes, skin, and clothing exactly." },
  undercut   : { label: '✂️ Андеркат',        hairPrompt: "COMPLETELY TRANSFORM the hairstyle into an undercut. The sides and back MUST be shaved nearly to skin. The top hair stays long (5-8cm) and is slicked or swept back. There MUST be a stark visible contrast line where very short sides meet the longer top hair. If hair is currently long or fluffy on sides, shave it down. Preserve the man's face, eyes, skin, and clothing exactly." },
  frenchcrop : { label: '🌾 Фр. кроп',        hairPrompt: "COMPLETELY TRANSFORM the hairstyle into a French crop. The result MUST show: short textured hair on top (2-3cm maximum) with a clear straight horizontal fringe line across the forehead at eyebrow level. Sides faded very short. The entire cut is compact and short — if hair is currently long, shorten it dramatically to this close-cropped style. Preserve the man's face, eyes, skin, and clothing exactly." },
  edgar      : { label: '⬛ Эдгар',            hairPrompt: "COMPLETELY TRANSFORM the hairstyle into an Edgar cut. The result MUST show: flat short hair on top (2-3cm) with a perfectly straight blunt horizontal fringe at the forehead, almost like a shelf. Sides faded very short. The top is boxy and rectangular. Dramatically shorten any existing long hair to this close-cropped style. Preserve the man's face, eyes, skin, and clothing exactly." },
  slickback  : { label: '💆 Слик бэк',        hairPrompt: "COMPLETELY TRANSFORM the hairstyle into a slick back. All hair on top MUST be visibly combed straight backward from forehead to nape in a smooth glossy flow — it looks wet and polished. Short faded sides. The hair direction must clearly go from front to back. Preserve the man's face, eyes, skin, and clothing exactly." },
  quiff      : { label: '🌟 Квифф',           hairPrompt: "COMPLETELY TRANSFORM the hairstyle into a quiff. The front section of hair MUST be swept upward and back, creating clear dramatic height and volume above the forehead. The sides are faded short. There must be visible upward-swept volume at the front of the head — a bold prominent quiff shape. Preserve the man's face, eyes, skin, and clothing exactly." },
  pompadour  : { label: '💈 Помпадур',        hairPrompt: "COMPLETELY TRANSFORM the hairstyle into a pompadour. A large volume of hair MUST be swept dramatically upward and backward from the forehead, creating significant height at the front. Sides are tapered or faded short. The sweeping arch of hair going up and back must be clearly visible and bold. Preserve the man's face, eyes, skin, and clothing exactly." },
  taper      : { label: '🎯 Тейпер',          hairPrompt: "COMPLETELY TRANSFORM the hairstyle into a modern taper fade. The sides and back taper from medium hair at the top down to skin-short at the bottom edges. The top has 4-6cm of textured hair. The gradual blend from skin to full hair along the sides must be clearly visible. Preserve the man's face, eyes, skin, and clothing exactly." },
  curly      : { label: '🌀 Кудри',           hairPrompt: "COMPLETELY TRANSFORM the hairstyle into curly hair with defined coils and strong volume. If hair is currently straight, it MUST visibly change to bouncy defined curls (4-8cm on top). The curl definition and ringlet texture must be obvious and prominent. Masculine curly hairstyle. Preserve the man's face, eyes, skin, and clothing exactly." },
  buzz       : { label: '⚡ Buzz Cut',         hairPrompt: "COMPLETELY TRANSFORM the hairstyle into a buzz cut. The hair MUST be uniformly very short (grade 2, approximately 6mm) over the ENTIRE head — top, sides, and back all equally short. If hair is currently long, it must be dramatically shortened to near-shaved all over. No fade, no variation — uniform very short buzz all around. Preserve the man's face, eyes, skin, and clothing exactly." },
};

const FEMALE_STYLES = {
  default     : { label: '✅ Свою причёску',   hairPrompt: "Keep the person's exact current hairstyle completely unchanged — same haircut, same length, same style. Only apply color changes if specified." },
  wolfcut     : { label: '🐺 Волчья стрижка', hairPrompt: "Restyle this woman's hair into a trendy wolf cut shag: heavily layered haircut with curtain bangs, lots of volume at the crown and wispy textured ends, effortlessly cool look. Keep her as a woman." },
  lob         : { label: '💁 Лоб (удл. каре)', hairPrompt: "Restyle this woman's hair into a long bob (lob): sleek straight hair cut just below the shoulders or at collarbone length with blunt ends. Keep her as a woman." },
  bob         : { label: '✂️ Каре',            hairPrompt: "Restyle this woman's hair into a sleek classic bob: straight hair cut precisely to jaw length with blunt ends, chic feminine look. Keep her as a woman." },
  curtainbangs: { label: '🎭 Шторки',          hairPrompt: "Add trendy curtain bangs: soft middle-parted wispy bangs that frame the face on both sides, keep the rest of the hair natural. Keep her as a woman." },
  longstraight: { label: '👸 Длинные прямые',  hairPrompt: "Restyle this woman's hair into long straight silky hair flowing well past the shoulders, glamorous sleek feminine style. Keep her as a woman." },
  layers      : { label: '🌿 Каскад',          hairPrompt: "Restyle this woman's hair into long layered cascading hair with soft flowing layers, volume and movement well past the shoulders. Keep her as a woman." },
  butterfly   : { label: '🦋 Баттерфляй',     hairPrompt: "Restyle this woman's hair into a butterfly haircut: shorter face-framing layers at the crown creating wings and volume, longer layers below for a dramatic trendy style. Keep her as a woman." },
  curly       : { label: '🌊 Локоны',          hairPrompt: "Restyle this woman's hair into long beautiful curly hair with defined bouncy feminine curls flowing past the shoulders. Keep her as a woman." },
  pixie       : { label: '💫 Пикси',           hairPrompt: "Restyle this woman's hair into a chic pixie cut: very short hair with slightly longer textured pieces on top, edgy modern feminine style. Keep her as a woman." },
  ponytail    : { label: '🎀 Хвостик',         hairPrompt: "Restyle this woman's hair into a sleek high ponytail: all hair pulled back smoothly and tied high on the head, polished feminine look. Keep her as a woman." },
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

// ─── Entry point ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Beauty AI Bot Platform — OK', { status: 200 });
    }

    const url = new URL(request.url);

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
      `Хотите продлить или сменить тариф? Напишите /tariff`
    );
    console.log(`[cron] reset monthly count for salon ${salon.id}, next reset: ${nextResetStr}`);
  }
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
    barber: '🎉 Вот твоя новая причёска!',
    makeup: '🎉 Вот твой новый образ!',
    nails : '🎉 Вот твой новый маникюр!',
  };
  const retryTexts  = {
    barber : `✂️ Хочешь примерить другую причёску? Пришли новое *СЕЛФИ*!`,
    makeup : `💄 Хочешь примерить другой образ? Пришли новое *ФОТО*!`,
    nails  : `💅 Хочешь попробовать другой дизайн? Пришли новое *ФОТО рук*!`,
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

    // Active subscription — handle admin commands
    if (message.text === '/tariff') {
      const used  = salon.monthly_generations_count ?? salon.plan_used  ?? 0;
      const limit = salon.max_allowed_generations   ?? salon.plan_limit ?? 0;
      const name  = salon.plan_name ?? salon.status ?? '—';
      await sendMessage(botToken, chatId,
        `📋 Тариф: *${name}* · использовано *${used}/${limit}* ген.\n\nВыберите тариф для продления:`,
        tariffKeyboard()
      );
      return;
    }

    if (message.text === '/push') {
      await setState(env, userId, botToken, S.SALON_PUSH_TEXT, {});
      await sendMessage(botToken, chatId,
        '📢 *Рассылка клиентам*\n\nНапиши текст сообщения которое получат все клиенты:',
        { remove_keyboard: true }
      );
      return;
    }
    if ([S.SALON_PUSH_TEXT, S.SALON_PUSH_BUTTONS, S.SALON_PUSH_CONFIRM].includes(state)) {
      await handleSalonPushMessage(message, salon, tempData, env, botToken, chatId, userId);
      return;
    }
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
    // At limit — show CTA, never reset the counter
    if ((user.image_count ?? 0) >= maxImages) {
      await sendOfferMessage(botToken, chatId, salon);
      return;
    }
    // Already processing — don't interrupt
    if (state === S.PROCESSING) {
      await sendMessage(botToken, chatId,
        '⏳ Твой результат уже генерируется! Пришлю как только будет готово — подожди.'
      );
      return;
    }
    if (user?.phone) {
      // Returning user — skip contact step, go straight to photo
      const remaining = maxImages - (user.image_count ?? 0);
      const hints = {
        barber: '📸 Пришли *СЕЛФИ* своего лица, подберём новую причёску!',
        makeup: '📸 Пришли *ФОТО лица*, подберём образ!',
        nails:  '📸 Пришли *ФОТО рук* ладонями вверх, подберём маникюр!',
      };
      await sendMessage(botToken, chatId,
        `👋 С возвращением! Осталось примерок: *${remaining}*.\n\n${hints[salon.salon_type] ?? hints.barber}`,
        { remove_keyboard: true }
      );
      const photoStates = { barber: S.WAITING_SELFIE, makeup: S.WAITING_FACE, nails: S.WAITING_HAND };
      await setState(env, userId, botToken, photoStates[salon.salon_type] ?? S.WAITING_SELFIE, {});
    } else {
      await onStart(message, salon, botToken, chatId);
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
      '👆 Нажми кнопку ниже, чтобы поделиться номером телефона.',
      contactKeyboard()
    );
  } else if (state === S.WAITING_COLOR) {
    await sendMessage(botToken, chatId, '🎨 Выбери цвет волос:', colorKeyboard());
  } else if (state === S.WAITING_STYLE_CHOICE) {
    const td = tempData;
    if (!td.gender) {
      await sendMessage(botToken, chatId, '👤 Для кого подбираем причёску?', genderKeyboard());
    } else {
      const kb = td.gender === 'male' ? maleStylesKeyboard() : femaleStylesKeyboard();
      await sendMessage(botToken, chatId, '💇 Выбери *стиль причёски*:', kb);
    }
  } else if ([S.WAITING_SELFIE, S.WAITING_FACE, S.WAITING_HAND].includes(state)) {
    await sendMessage(botToken, chatId, '📸 Пришли фотографию, пожалуйста.');
  } else if (state === S.PROCESSING) {
    await sendMessage(botToken, chatId,
      '⏳ Твой результат уже генерируется! Пришлю, как только будет готово — обычно 30–60 секунд.'
    );
  } else if (state === S.DONE) {
    // User finished all free tries — push them to the booking CTA
    await sendOfferMessage(botToken, chatId, salon);
  } else {
    // Unknown state or 'start' — redirect to /start, no conversation
    const hints = {
      barber: '✂️ Нажми /start чтобы примерить причёску!',
      makeup: '💄 Нажми /start чтобы примерить макияж!',
      nails:  '💅 Нажми /start чтобы примерить маникюр!',
    };
    await sendMessage(botToken, chatId, hints[salon.salon_type] ?? '👋 Нажми /start чтобы начать!');
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
  const botToken = env.STANDARD_BOT_TOKEN;

  // ── Platform admin: route to admin panel ─────────────────────────────────
  const senderId = String(
    (update.message ?? update.edited_message ?? update.callback_query)?.from?.id ?? ''
  );
  if (env.ADMIN_USER_ID && senderId === String(env.ADMIN_USER_ID)) {
    await handleAdminUpdate(update, env);
    return;
  }

  // ── Callback queries ──────────────────────────────────────────────────────
  if (update.callback_query) {
    const cq     = update.callback_query;
    const chatId = String(cq.message.chat.id);
    const userId = String(cq.from.id);

    // B2B package/tariff selection callbacks
    if (cq.data?.startsWith('b2b_pkg_') || cq.data === 'b2b_hosting_own') {
      await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });
      await handleB2bPackageCallback(cq.data, botToken, chatId, env);
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

  // ── B2B onboarding state check (before owner/client routing) ─────────────
  if (!text.startsWith('/start')) {
    const stateRow = await env.beauty_ai_db
      .prepare('SELECT state, temp_data FROM user_states WHERE user_id = ? AND bot_token = ?')
      .bind(userId, botToken).first();
    const state = stateRow?.state ?? 'start';
    if (state === S.B2B_NAME || state === S.B2B_PHONE) {
      await handleB2bOnboarding(message, env, userId, chatId, botToken, state,
        JSON.parse(stateRow?.temp_data ?? '{}'));
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
          `👋 Привет! Я помогу подключить ИИ-ассистента для вашего барбершопа или салона.\n\n` +
          `*За 3 минуты вы увидите как это работает изнутри.*\n\n` +
          `🎯 Как происходит:\n` +
          `1. Вводите данные салона\n` +
          `2. Делаете 3 тестовые генерации как ваш клиент\n` +
          `3. Выбираете пакет подписки\n\n` +
          `✍️ Введите *название* вашего салона или барбершопа:`
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
      let activeSalon = salon;
      if (!salon.admin_chat_id) {
        await env.beauty_ai_db
          .prepare('UPDATE salons SET admin_chat_id = ? WHERE id = ?')
          .bind(userId, salon.id).run();
        activeSalon = { ...salon, admin_chat_id: userId };
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
      await env.beauty_ai_db
        .prepare('UPDATE users SET salon_id = ? WHERE user_id = ? AND bot_token = ?')
        .bind(activeSalon.id, userId, botToken).run();

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

async function createTrialSalon(env, name, phone, sourceTrack = 'direct', adminChatId = null) {
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
      VALUES (?, ?, 'trial', ?, ?, 'barber', ?, ?, 3, 3, 0, ?)
    `)
    .bind(slug, syntheticToken, name, name, phone,
          adminChatId ? String(adminChatId) : null, sourceTrack ?? null)
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
    await setState(env, userId, botToken, S.B2B_PHONE, { ...tempData, b2b_name: text });
    await sendMessage(botToken, chatId,
      `✅ *${text}*\n\n📱 Введите WhatsApp-номер салона (только цифры):\n_Например: 77001112233_`
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
    const salon = await createTrialSalon(env, tempData.b2b_name, phone, sourceTrack, userId);

    await env.beauty_ai_db
      .prepare('INSERT OR IGNORE INTO users (user_id, bot_token, salon_id, image_count) VALUES (?, ?, ?, 0)')
      .bind(userId, botToken, salon.id).run();
    await env.beauty_ai_db
      .prepare('UPDATE users SET salon_id = ? WHERE user_id = ? AND bot_token = ?')
      .bind(salon.id, userId, botToken).run();

    await sendMessage(botToken, chatId,
      `🎉 *${salon.name}* — тест-драйв запущен!\n\n` +
      `Вы попробуете бота *как ваш клиент* — доступно *3 бесплатных генерации*.\n\n` +
      `📸 Пришлите *СЕЛФИ* лица — подберём причёску!`
    );
    await setState(env, userId, botToken, S.WAITING_SELFIE, {});
  }
}

// ─── B2B tariff / package selector (shown after trial ends) ──────────────────

async function showB2bTariffSelector(botToken, chatId) {
  await sendMessage(botToken, chatId,
    `🎉 *Тест-драйв завершён!*\n\n` +
    `Вы увидели как работает ИИ-ассистент для клиентов вашего салона.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 *Пакеты подписки (в месяц):*\n\n` +
    `🟢 Мини — 150 ген. — ₸9,900\n` +
    `🔵 Стандарт — 300 ген. — ₸14,900\n` +
    `🟣 Бизнес — 600 ген. — ₸24,900\n` +
    `⭐ Сеть — 1 200 ген. — ₸44,900\n\n` +
    `🤖 *Тип размещения:*\n` +
    `• В общем боте — бесплатно\n` +
    `• В своём боте — +₸25,000\n\n` +
    `Выберите подходящий пакет 👇`,
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
    ]}
  );
}

async function handleB2bPackageCallback(data, botToken, chatId, env) {
  const packages = {
    b2b_pkg_mini_shared : { name: 'Мини',     price: 9900,  gens: 150,  own: false },
    b2b_pkg_std_shared  : { name: 'Стандарт', price: 14900, gens: 300,  own: false },
    b2b_pkg_biz_shared  : { name: 'Бизнес',   price: 24900, gens: 600,  own: false },
    b2b_pkg_net_shared  : { name: 'Сеть',     price: 44900, gens: 1200, own: false },
  };

  if (data === 'b2b_hosting_own') {
    await sendMessage(botToken, chatId,
      `🤖 *Свой бот (+₸25,000)*\n\n` +
      `К стоимости любого пакета добавляется ₸25,000 за создание и настройку личного бота.\n\n` +
      `Выберите пакет подписки 👇`,
      { inline_keyboard: [
        [
          { text: '🟢 Мини · ₸34,900',      callback_data: 'b2b_pkg_mini_own'  },
          { text: '🔵 Стандарт · ₸39,900',  callback_data: 'b2b_pkg_std_own'   },
        ],
        [
          { text: '🟣 Бизнес · ₸49,900',    callback_data: 'b2b_pkg_biz_own'   },
          { text: '⭐ Сеть · ₸69,900',      callback_data: 'b2b_pkg_net_own'   },
        ],
      ]}
    );
    return;
  }

  const pkg = packages[data] ?? packages[data?.replace('_own', '_shared')];
  if (!pkg) return;

  const isOwn  = data.endsWith('_own');
  const total  = pkg.price + (isOwn ? 25000 : 0);
  const hosting = isOwn ? ' + свой бот' : ' (в общем боте)';

  await sendMessage(botToken, chatId,
    `✅ Отличный выбор!\n\n` +
    `📦 *${pkg.name}${hosting}*\n` +
    `📊 ${pkg.gens} генераций в месяц\n` +
    `💳 Сумма: *₸${total.toLocaleString('ru')}*\n\n` +
    `Менеджер свяжется с вами в ближайшее время для оформления.\n\n` +
    `_Или напишите нам прямо сейчас — мы всё настроим быстро!_`
  );

  // Notify admin of the B2B lead
  const adminId = env.ADMIN_USER_ID;
  if (adminId) {
    await sendMessage(env.STANDARD_BOT_TOKEN ?? env.ADMIN_BOT_TOKEN, adminId,
      `🔥 *B2B лид!*\n\nПакет: *${pkg.name}${hosting}*\nСумма: ₸${total.toLocaleString('ru')}\nChat ID: \`${chatId}\``
    );
  }
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

// ─── /start ──────────────────────────────────────────────────────────────────
async function onStart(message, salon, botToken, chatId) {
  const name = message.from.first_name || 'друг';

  const greetings = {
    barber: `✂️ Привет, ${name}!\n\nДобро пожаловать в *${salon.salon_name}*!\n\nС нашим ИИ-ботом ты можешь примерить любую причёску — прямо сейчас, без визита в салон!\n\n🎯 *Как это работает:*\n1. Поделись контактом\n2. Загрузи селфи\n3. Выбери пол → причёску → цвет\n4. Получи ИИ-результат за ~60 сек!\n\n_Доступно ${salon.max_images} бесплатных примерки_\n\n👇 Нажми кнопку ниже:`,

    makeup: `💄 Привет, ${name}!\n\nДобро пожаловать в *${salon.salon_name}*!\n\nПримерь профессиональный макияж с помощью ИИ — быстро и красиво!\n\n🎯 *Как это работает:*\n1. Поделись контактом\n2. Загрузи фото лица\n3. ИИ нанесёт макияж\n4. Получи результат за ~60 сек!\n\n_Доступно ${salon.max_images} бесплатных примерки_\n\n👇 Нажми кнопку ниже:`,

    nails: `💅 Привет, ${name}!\n\nДобро пожаловать в *${salon.salon_name}*!\n\nПримерь трендовые дизайны маникюра с помощью ИИ!\n\n🎯 *Как это работает:*\n1. Поделись контактом\n2. Загрузи фото рук\n3. ИИ наложит дизайн\n4. Получи результат за ~60 сек!\n\n_Доступно ${salon.max_images} бесплатных примерки_\n\n👇 Нажми кнопку ниже:`,
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
      text  : `✅ Контакт получен!\n\nДавай подберём причёску! ✂️\n\n*📸* Пришли чёткое *СЕЛФИ* своего лица (фронтально, при хорошем освещении).`,
      state : S.WAITING_SELFIE,
    },
    makeup: {
      text  : `✅ Контакт получен!\n\nПора создать твой образ! 💄\n\n*📸* Пришли чёткое *ФОТО своего лица* (фронтально, при хорошем освещении).`,
      state : S.WAITING_FACE,
    },
    nails: {
      text  : `✅ Контакт получен!\n\nДавай подберём маникюр! 💅\n\n*📸* Пришли *ФОТО своих рук* (ладонями вверх, при хорошем освещении).`,
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
    await sendMessage(botToken, chatId, '💇 Выбери *стиль причёски*:', kb);
    return;
  }

  // ── Style selection ──
  if ((data.startsWith('mstyle_') || data.startsWith('fstyle_')) && state === S.WAITING_STYLE_CHOICE) {
    const storedGender = tempData.gender;
    // Guard against stale keyboard buttons from previous sessions
    const callbackIsMale = data.startsWith('mstyle_');
    if (!storedGender) {
      await sendMessage(botToken, chatId, '👆 Сначала выбери для кого причёска:', genderKeyboard());
      return;
    }
    if (callbackIsMale && storedGender !== 'male') {
      await sendMessage(botToken, chatId, '👆 Выбери стиль причёски:', femaleStylesKeyboard());
      return;
    }
    if (!callbackIsMale && storedGender !== 'female') {
      await sendMessage(botToken, chatId, '👆 Выбери стиль причёски:', maleStylesKeyboard());
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
    });
    const colorPrompt = isDefault
      ? `✅ Оставляем твою причёску!\n\n🎨 Выбери *новый цвет волос*:`
      : `✅ Стиль: *${preset.label}*\n\n🎨 Выбери *цвет волос* (или оставь свой):`;
    await sendMessage(botToken, chatId, colorPrompt, colorKeyboard());
    return;
  }

  // ── Color selection → submit job ──
  if (data.startsWith('color_') && state === S.WAITING_COLOR) {
    const colorKey = data.replace('color_', '');
    const color    = HAIR_COLORS[colorKey];
    if (!color || !tempData.selfie_url || !tempData.style_prompt) {
      await sendMessage(botToken, chatId, '⚠️ Что-то пошло не так. Начни заново — пришли селфи.');
      await setState(env, userId, botToken, S.WAITING_SELFIE, {});
      return;
    }

    // "Своя причёска" + "Свой цвет" — менять нечего, просим выбрать цвет
    if (tempData.style_is_default && !color.colorPrompt) {
      await sendMessage(botToken, chatId,
        '🎨 Ты оставляешь свою причёску — тогда нужно выбрать *новый цвет* волос.\n\nВыбери цвет из списка:',
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

    const colorPart = color.colorPrompt ? ` Color the hair to ${color.colorPrompt}.` : '';
    const fullPrompt = tempData.style_prompt + colorPart + FACE_FINISH;

    const styleLabel = tempData.style_label ?? '';
    const colorLabel = color.label !== '✅ Мой цвет' ? ` · ${color.label}` : '';
    await sendMessage(botToken, chatId,
      `⏳ Генерирую *${styleLabel}${colorLabel}*… Пришлю результат через ~60 секунд. ✨`
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

  const adminToken = env.STANDARD_BOT_TOKEN ?? env.ADMIN_BOT_TOKEN;
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

  await sendMessage(env.STANDARD_BOT_TOKEN ?? env.ADMIN_BOT_TOKEN, adminChatId,
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
    const clientCount = await getPushClientCount(env, botToken);
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
    const clientCount = await getPushClientCount(env, botToken);
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
    const clientCount = await getPushClientCount(env, botToken);
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
    const sent = await sendSalonPush(env, botToken, push_text, push_buttons ?? []);
    await sendMessage(botToken, chatId, `✅ Рассылка отправлена *${sent}* клиентам!`);
    return;
  }

  if (data === 'spush_cancel') {
    await setState(env, userId, botToken, 'start', {});
    await sendMessage(botToken, chatId, '❌ Рассылка отменена.', { remove_keyboard: true });
    return;
  }
}

async function getPushClientCount(env, botToken) {
  const row = await env.beauty_ai_db
    .prepare('SELECT COUNT(*) as cnt FROM users WHERE bot_token = ?')
    .bind(botToken).first();
  return row?.cnt ?? 0;
}

async function sendSalonPush(env, botToken, text, buttons) {
  const users = await env.beauty_ai_db
    .prepare('SELECT DISTINCT chat_id FROM pending_jobs WHERE bot_token = ?')
    .bind(botToken).all();

  // Use users table — get all who have interacted (have a phone = registered)
  const clients = await env.beauty_ai_db
    .prepare('SELECT DISTINCT user_id FROM users WHERE bot_token = ?')
    .bind(botToken).all();

  const replyMarkup = buttons.length
    ? { inline_keyboard: [buttons.map(b => ({ text: b.text, url: b.url }))] }
    : null;

  let sent = 0;
  for (const client of clients.results) {
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
      guidance_scale  : 10,
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
        `Срочно докупите пакет или перейдите на более высокий тариф: /tariff`
      );
    }
  }

  if (newCount >= maxImages) {
    // B2B trial owner finishes test-drive → show tariff/package selector
    if (salon.status === 'trial' && String(chatId) === String(salon.admin_chat_id)) {
      await showB2bTariffSelector(botToken, chatId);
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
    waText     = `Привет! Я использовал ИИ-бот ${salon.salon_name} и хочу записаться со скидкой ${disc}% 🎉`;
    buttonText = `🟢 Записаться со скидкой ${disc}% в WhatsApp`;
    bodyText   = [
      `🎉 *Ты использовал все ${salon.max_images} бесплатных примерки!*`,
      '',
      `Тебе понравился результат? Самое время воплотить его в реальность!`,
      '',
      `🎁 *Специально для тебя — скидка ${disc}% на первый визит в ${salon.salon_name}!*`,
      '',
      `Просто нажми кнопку ниже 👇`,
    ].join('\n');
  } else {
    waText     = `Привет! Я попробовал ИИ-бот ${salon.salon_name} и хочу записаться. Хочу сделать такую же причёску как на фото!`;
    buttonText = `💈 Записаться в WhatsApp`;
    bodyText   = [
      `🎉 *Ты использовал все ${salon.max_images} бесплатных примерки!*`,
      '',
      `Нравится результат? Самое время воплотить его в реальность!`,
      '',
      `Запишись в *${salon.salon_name}* — скажи что хочешь такую же причёску как на фото!`,
      '',
      `👇 Нажми кнопку ниже:`,
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
};

async function handleAdminUpdate(update, env) {
  const callbackQuery = update.callback_query;
  const message       = update.message;

  if (callbackQuery) {
    const userId = String(callbackQuery.from.id);
    const chatId = String(callbackQuery.message.chat.id);
    if (userId !== String(env.ADMIN_USER_ID)) {
      // Non-admin callback → registration flow
      await fetch(`${TELEGRAM_API}/bot${env.ADMIN_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQuery.id }),
      });
      await handleRegCallback(callbackQuery, env, userId, chatId);
    } else {
      await handleAdminCallback(callbackQuery, env);
    }
    return;
  }
  if (!message) return;

  const userId = String(message.from.id);
  const chatId = String(message.chat.id);

  // Non-admin → registration flow
  if (userId !== String(env.ADMIN_USER_ID)) {
    await handleRegMessage(message, env, userId, chatId);
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
    '📢 Рассылка', '➕ Создать триал', '📄 Шаблон CSV', '📤 Загрузить CSV', '➕ Добавить бота'];
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
      await setAdminState(env, userId, A.CREATE_TRIAL_PHONE, { trial_name: name });
      await adminSend(env, chatId, `✅ *${name}*\n\n📱 Введи WhatsApp-номер (только цифры):\n_Например: 77001112233_`);
      break;
    }

    case A.CREATE_TRIAL_PHONE: {
      const phone = message.text?.replace(/\D/g, '') ?? '';
      if (phone.length < 10) {
        await adminSend(env, chatId, '❌ Неверный номер. Только цифры, минимум 10.');
        break;
      }
      const salon = await createTrialSalon(env, tempData.trial_name, phone, 'admin_create');
      const botUsername = env.STANDARD_BOT_USERNAME ?? 'qrbeatyai_bot';
      const link = `https://t.me/${botUsername}?start=${salon.slug}`;
      await setAdminState(env, userId, A.START, {});
      await adminSend(env, chatId,
        `✅ *Триал создан!*\n\n✂️ *${salon.name}*\n📱 WhatsApp: \`${phone}\`\n🔗 Ссылка для оунера:\n\`${link}\`\n\n_Когда оунер откроет ссылку, его Telegram ID автоматически привяжется._`
      );
      await showAdminMenu(env, chatId);
      break;
    }

    case A.MASS_TRIAL_WAIT:
      await adminSend(env, chatId, '📎 Пришли CSV-файл (без подписи — просто файлом).');
      break;
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
  const fileUrl = await getTelegramFileUrl(env.STANDARD_BOT_TOKEN ?? env.ADMIN_BOT_TOKEN, fileId);
  const raw     = await (await fetch(fileUrl)).text();

  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    await adminSend(env, chatId, '❌ Файл пустой или неверный формат.');
    return;
  }

  await adminSend(env, chatId, `⏳ Обрабатываю ${lines.length - 1} строк…`);

  const botUsername = env.STANDARD_BOT_USERNAME ?? 'YourBot';
  const resultRows  = ['Название;Телефон;Ссылка;Готовый Текст Скрипта'];
  let created = 0, skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    if (parts.length < 2) { skipped++; continue; }

    const [name, phone, source] = parts.map(p => p.trim());
    if (!name || !phone) { skipped++; continue; }

    try {
      const salon = await createTrialSalon(env, name, phone.replace(/\D/g, ''), source || 'mass_trial');
      const link  = `https://t.me/${botUsername}?start=${salon.slug}`;
      const script = `Привет! Мы создали для «${name}» персонального ИИ-ассистента. Попробуйте бесплатно → ${link}`;
      resultRows.push(`${name};${phone};${link};${script}`);
      created++;
    } catch (err) {
      console.error('[mass_trial]', name, err.message);
      resultRows.push(`${name};${phone};ERROR;${err.message}`);
      skipped++;
    }
  }

  const resultCsv = resultRows.join('\n');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document',
    new File([new Blob([resultCsv], { type: 'text/csv' })], 'trial_results.csv', { type: 'text/csv' }),
    'trial_results.csv'
  );
  form.append('caption', `✅ Создано: *${created}*, пропущено: *${skipped}*`);
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

  if (userId !== String(env.ADMIN_USER_ID)) return;

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
    if (target === 'ALL') {
      targetLabel = 'все боты';
    } else {
      const sln = await env.beauty_ai_db
        .prepare('SELECT salon_name FROM salons WHERE bot_token = ?')
        .bind(target).first();
      targetLabel = sln?.salon_name ?? 'бот';
    }
    await setAdminState(env, userId, A.BROADCAST_TEXT, { broadcast_target: target });
    await adminSend(env, chatId,
      `✍️ *Рассылка — ${targetLabel}*\n\nНапиши текст сообщения.\n\n_Он будет отправлен всем клиентам, поделившимся контактом._`
    );
    return;
  }
}

// ── Admin menu ────────────────────────────────────────────────────────────────

async function showAdminMenu(env, chatId) {
  await adminSend(env, chatId,
    '🤖 *Панель управления Beauty AI*\n\nВыбери действие:',
    {
      keyboard: [
        ['📋 Мои боты', '👥 Все клиенты'],
        ['📥 Экспорт базы', '📢 Рассылка'],
        ['➕ Создать триал', '📄 Шаблон CSV'],
        ['📤 Загрузить CSV', '➕ Добавить бота'],
        ['🏠 Главное меню'],
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
  } else if (text === '📄 Шаблон CSV') {
    await sendMassTrialTemplate(env, chatId);
  } else if (text === '📤 Загрузить CSV') {
    await setAdminState(env, userId, A.MASS_TRIAL_WAIT, {});
    await adminSend(env, chatId,
      '📎 Пришли CSV-файл со списком салонов.\n\n_Формат: Название;Телефон;Источник_\n_Нужен шаблон? Нажми *📄 Шаблон CSV*_'
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

  const emoji = { barber: '✂️', makeup: '💄', nails: '💅' };
  let text = `📋 *Твои боты (${results.length}):*\n\n`;
  const buttons = [];

  for (const s of results) {
    text += `${emoji[s.salon_type] ?? '🤖'} *${s.salon_name}*\n`;
    text += `   Тип: \`${s.salon_type}\` | Клиентов: *${s.client_count}* | Лимит: ${s.max_images} фото\n\n`;
    buttons.push([
      { text: `👥 Клиенты — ${s.salon_name}`, callback_data: `clients_${s.bot_token}` },
      { text: `🗑 Удалить`,                   callback_data: `del_ask_${s.bot_token}` },
    ]);
  }

  await adminSend(env, chatId, text, { inline_keyboard: buttons });
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

  if (message.text === '/start' || state === 'reg_start') {
    await adminSend(env, chatId,
      `🤖 *Beauty AI — Подключение салона*\n\n` +
      `Добро пожаловать! Этот бот подключает ИИ-помощника для вашего барбершопа или салона.\n\n` +
      `*Что понадобится:*\n• Название салона на английском\n• WhatsApp для записи клиентов\n• Логотип салона\n\n` +
      `Нажмите кнопку чтобы начать 👇`,
      { inline_keyboard: [[{ text: '🚀 Подать заявку', callback_data: 'reg_start' }]] }
    );
    await setRegState(env, userId, 'reg_start', {});
    return;
  }

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
    .prepare('SELECT bot_token, salon_name, salon_type FROM salons ORDER BY salon_name')
    .all();

  if (!salons.length) {
    await adminSend(env, chatId, 'У тебя нет ботов для рассылки. Сначала добавь бота.');
    return;
  }

  const emoji = { barber: '✂️', makeup: '💄', nails: '💅' };
  const buttons = [
    [{ text: '📢 Все боты сразу', callback_data: 'bcast_ALL' }],
    ...salons.map(s => [{ text: `${emoji[s.salon_type] ?? '🤖'} ${s.salon_name}`, callback_data: `bcast_${s.bot_token}` }]),
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

  let stmt;
  if (target === 'ALL') {
    stmt = env.beauty_ai_db.prepare('SELECT user_id, bot_token FROM users WHERE phone IS NOT NULL');
  } else {
    stmt = env.beauty_ai_db.prepare('SELECT user_id, bot_token FROM users WHERE phone IS NOT NULL AND bot_token = ?').bind(target);
  }
  const { results: recipients } = await stmt.all();

  if (!recipients.length) {
    await adminSend(env, chatId, '📭 Нет клиентов для рассылки (никто не поделился контактом).');
    await setAdminState(env, userId, A.START, {});
    await showAdminMenu(env, chatId);
    return;
  }

  await adminSend(env, chatId, `⏳ Отправляю ${recipients.length} сообщений…`);

  let sent = 0, failed = 0;
  // Send in batches of 25 to respect Telegram rate limits
  const BATCH = 25;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const batch = recipients.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(u => sendMessage(u.bot_token, u.user_id, text))
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

  const token = env.STANDARD_BOT_TOKEN ?? env.ADMIN_BOT_TOKEN;
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) console.error(`sendDocument error: ${res.status} ${await res.text()}`);
}

async function adminSend(env, chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const token = env.STANDARD_BOT_TOKEN ?? env.ADMIN_BOT_TOKEN;
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
    barber: '🎉 Вот твоя новая причёска!',
    makeup: '🎉 Вот твой новый образ!',
    nails : '🎉 Вот твой новый маникюр!',
  };
  const retryTexts  = {
    barber : `✂️ Хочешь примерить другую причёску? Пришли новое *СЕЛФИ*!`,
    makeup : `💄 Хочешь примерить другой образ? Пришли новое *ФОТО*!`,
    nails  : `💅 Хочешь попробовать другой дизайн? Пришли новое *ФОТО рук*!`,
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
  return { inline_keyboard: [
    [{ text: MALE_STYLES.default.label,    callback_data: 'mstyle_default'    }],
    [{ text: MALE_STYLES.fade.label,       callback_data: 'mstyle_fade'       }, { text: MALE_STYLES.undercut.label,   callback_data: 'mstyle_undercut'   }],
    [{ text: MALE_STYLES.frenchcrop.label, callback_data: 'mstyle_frenchcrop' }, { text: MALE_STYLES.edgar.label,      callback_data: 'mstyle_edgar'      }],
    [{ text: MALE_STYLES.slickback.label,  callback_data: 'mstyle_slickback'  }, { text: MALE_STYLES.quiff.label,      callback_data: 'mstyle_quiff'      }],
    [{ text: MALE_STYLES.pompadour.label,  callback_data: 'mstyle_pompadour'  }, { text: MALE_STYLES.taper.label,      callback_data: 'mstyle_taper'      }],
    [{ text: MALE_STYLES.curly.label,      callback_data: 'mstyle_curly'      }, { text: MALE_STYLES.buzz.label,       callback_data: 'mstyle_buzz'       }],
  ]};
}

function femaleStylesKeyboard() {
  return { inline_keyboard: [
    [{ text: FEMALE_STYLES.default.label,      callback_data: 'fstyle_default'      }],
    [{ text: FEMALE_STYLES.wolfcut.label,       callback_data: 'fstyle_wolfcut'      }, { text: FEMALE_STYLES.lob.label,          callback_data: 'fstyle_lob'          }],
    [{ text: FEMALE_STYLES.bob.label,           callback_data: 'fstyle_bob'          }, { text: FEMALE_STYLES.curtainbangs.label,  callback_data: 'fstyle_curtainbangs'  }],
    [{ text: FEMALE_STYLES.longstraight.label,  callback_data: 'fstyle_longstraight' }, { text: FEMALE_STYLES.layers.label,        callback_data: 'fstyle_layers'        }],
    [{ text: FEMALE_STYLES.butterfly.label,     callback_data: 'fstyle_butterfly'    }, { text: FEMALE_STYLES.curly.label,         callback_data: 'fstyle_curly'         }],
    [{ text: FEMALE_STYLES.pixie.label,         callback_data: 'fstyle_pixie'        }, { text: FEMALE_STYLES.ponytail.label,      callback_data: 'fstyle_ponytail'      }],
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
