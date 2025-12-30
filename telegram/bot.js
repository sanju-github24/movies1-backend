import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

// =======================
// EXPORTABLE START FUNCTION
// =======================
export function startTelegramBot() {
  // =======================
  // INIT
  // =======================
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

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

  // Check if message contains a file
  const hasFile = msg.video || msg.document;

  // ❌ Non-admin trying to upload/forward file
  if (hasFile && userId !== ADMIN_ID) {
    return bot.sendMessage(
      chatId,
      "⛔ You are not authorized to add or forward files.\n\nOnly admin can upload files.",
      { reply_to_message_id: msg.message_id }
    );
  }

  // ✅ Allow ONLY admin beyond this point
  if (userId !== ADMIN_ID) return;

  let file = null;

  // 🎥 VIDEO (upload or forward)
  if (msg.video) {
    file = {
      file_name: msg.video.file_name || msg.caption || "Video file",
      file_id: msg.video.file_id,
      file_type: "video",
      file_size: msg.video.file_size || null,
    };
  }

  // 📄 DOCUMENT (upload or forward)
  if (msg.document) {
    file = {
      file_name: msg.document.file_name,
      file_id: msg.document.file_id,
      file_type: "document",
      file_size: msg.document.file_size || null,
    };
  }

  if (!file) return;

  // 🎯 Generate unique 3-digit code
  const fileCode = await generateUniqueCode();

  // 💾 Save to Supabase
  await supabase.from("telegram_files").insert([
    { ...file, file_code: fileCode }
  ]);

  const downloadUrl = `https://t.me/${process.env.BOT_USERNAME}?start=${fileCode}`;

  // ✅ Admin confirmation
  bot.sendMessage(
    chatId,
    `✅ File saved successfully

📄 File: ${file.file_name}
🔢 Code: ${fileCode}
🔗 ${downloadUrl}`,
    { disable_web_page_preview: true }
  );
});


  bot.onText(/\/start (\d{3})/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const code = match[1];

    const joined = await isUserMember(userId);
    if (!joined) {
      return bot.sendMessage(
        chatId,
        `🔒 Join our channel to download

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

    let sent;
    if (data.file_type === "video") {
      sent = await bot.sendVideo(chatId, data.file_id);
    } else {
      sent = await bot.sendDocument(chatId, data.file_id);
    }

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

  console.log("🤖 Telegram bot started");
}
