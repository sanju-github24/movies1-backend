import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

// =======================
// EXPORTABLE START FUNCTION
// =======================
export function startTelegramBot() {
  // CRITICAL FIX FOR 409 CONFLICT:
  // If your backend runs multiple workers/instances, disable polling on extra instances
  if (process.env.DISABLE_BOT_POLLING === "true") {
    console.log("🤫 Telegram Bot Polling is disabled on this instance to prevent 409 Conflict.");
    return;
  }

  if (global.telegramBotInstance) {
    console.log("⚠️ Stopping previous bot instance to prevent 409 Conflict...");
    try {
      global.telegramBotInstance.stopPolling();
    } catch (e) {
      console.error("Failed to stop previous polling:", e);
    }
  }

  // =======================
  // INIT
  // =======================
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
  
  // Save instance globally to track it
  global.telegramBotInstance = bot;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const ADMIN_ID = 1829896755;
  const REQUIRED_CHANNEL = "@anchor2025";

  // =======================
  // CHECK CHANNEL MEMBERSHIP
  // =======================
  async function isUserMember(userId) {
    try {
      const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
      return ["member", "administrator", "creator"].includes(member.status);
    } catch {
      return false;
    }
  }

  // =======================
  // RANDOM 3-DIGIT CODE
  // =======================
  async function generateUniqueCode() {
    while (true) {
      const code = Math.floor(100 + Math.random() * 900).toString();
      const { data } = await supabase
        .from("telegram_files")
        .select("id")
        .eq("file_code", code)
        .maybeSingle();
      if (!data) return code;
    }
  }

  // =======================
  // HANDLE FILE RECEIVE
  // ADMIN ONLY (UPLOAD + FORWARD)
  // =======================
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    const hasFile = msg.video || msg.document;

    if (hasFile && userId !== ADMIN_ID) {
      return bot.sendMessage(
        chatId,
        "⛔ You are not authorized to add or forward files.\n\nOnly admin can upload files.",
        { reply_to_message_id: msg.message_id }
      );
    }

    if (userId !== ADMIN_ID) return;

    let file = null;

    if (msg.video) {
      file = {
        file_name: msg.video.file_name || msg.caption || "Video file",
        file_id: msg.video.file_id,
        file_type: "video",
        file_size: msg.video.file_size || null,
      };
    }

    if (msg.document) {
      file = {
        file_name: msg.document.file_name || msg.caption || "Document file",
        file_id: msg.document.file_id,
        file_type: "document",
        file_size: msg.document.file_size || null,
      };
    }

    if (!file) return;

    const fileCode = await generateUniqueCode();

    await supabase.from("telegram_files").insert([
      { ...file, file_code: fileCode }
    ]);

    const downloadUrl = `https://t.me/${process.env.BOT_USERNAME}?start=${fileCode}`;

    bot.sendMessage(
      chatId,
      `✅ File saved successfully

📄 File: ${file.file_name}
🔢 Code: ${fileCode}
🔗 ${downloadUrl}`,
      { disable_web_page_preview: true }
    );
  });

  // =======================
  // HANDLE /start <code>
  // =======================
  bot.onText(/\/start (\d{3})/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const code = match[1];

    const joined = await isUserMember(userId);
    if (!joined) {
      return bot.sendMessage(
        chatId,
        `🔒 Join our channel to watch

👉 https://t.me/anchor2025`,
        { disable_web_page_preview: true }
      );
    }

    const { data } = await supabase
      .from("telegram_files")
      .select("*")
      .eq("file_code", code)
      .maybeSingle();

    if (!data) {
      return bot.sendMessage(chatId, "❌ Invalid or expired code");
    }

    console.log("========== WATCH DEBUG ==========");
    console.log("CODE:", code);
    console.log("DATA:", data);
    console.log("FILE NAME:", data?.file_name);
    console.log("FILE TYPE:", data?.file_type);
    console.log("BACKEND_URL FROM ENV:", process.env.BACKEND_URL);
    console.log("================================");

    // Clean up backend URL to ensure absolute protocol format
    let BACKEND_URL = process.env.BACKEND_URL || "";
    if (BACKEND_URL && !BACKEND_URL.startsWith("http://") && !BACKEND_URL.startsWith("https://")) {
      BACKEND_URL = `https://${BACKEND_URL}`;
    }
    BACKEND_URL = BACKEND_URL.replace(/\/+$/, ""); // Trim trailing slashes

    const fileName = data.file_name || "Movie";
    
    // UPDATED: Points directly to your static public raw HTML player page file structure 
    const playerLink = `${BACKEND_URL}/public/player.html?fileId=${encodeURIComponent(data.file_id)}&title=${encodeURIComponent(fileName)}`;

    console.log("PLAYER LINK GENERATED:", playerLink);

    // Generate Play button unconditionally for all files
    try {
      await bot.sendMessage(
        chatId,
        `▶️ Watch Online\n\n🎬 ${fileName}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "▶️ Play Now",
                  url: playerLink,
                },
              ],
            ],
          },
        }
      );

      console.log("✅ Watch button sent");
    } catch (err) {
      console.error("❌ Watch button failed:", err.response?.body || err);
      // Fallback debug alert to user interface if URL parameters break
      await bot.sendMessage(
        chatId,
        `⚠️ Play button generation error:\n${JSON.stringify(err.response?.body || err.message)}`
      );
    }

    // Send the file as normal...
    let sent;

    if (data.file_type === "video") {
      sent = await bot.sendVideo(
        chatId,
        data.file_id,
        {
          caption: `🎬 ${fileName}`,
          supports_streaming: true,
        }
      );
    } else {
      sent = await bot.sendDocument(
        chatId,
        data.file_id,
        {
          caption: `📄 ${fileName}`,
        }
      );
    }

    // Auto-delete notice + file after 10 minutes
    const notice = await bot.sendMessage(
      chatId,
      `⚠️ File auto-deletes in 10 minutes

Download and watch more movies at:
🌐 https://1anchormovies.live

Share our channel with friends:
📢 https://t.me/anchor2025`,
      { disable_web_page_preview: true }
    );

    setTimeout(async () => {
      try {
        await bot.deleteMessage(chatId, sent.message_id);
        await bot.deleteMessage(chatId, notice.message_id);
      } catch {}
    }, 10 * 60 * 1000);
  });

  console.log("🤖 Telegram bot started successfully");
}
