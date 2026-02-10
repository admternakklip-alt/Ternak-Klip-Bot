require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");

// ────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_USERS_TABLE = "users";

const isValidString = (str) => {
  return typeof str === "string" && str.trim().length > 0;
};

const PREFIX = "!";
const REGISTERED_ROLE_NAME = "Members";
const VERIFICATION_CODE_EXPIRATION_SECONDS = 3600;
const EPHEMERAL_FLAG = 64;

// Modal & Button Custom IDs
const MODAL_ID_VERIFY = "modal_verify_account";
const MODAL_ID_EDIT_PAYMENT = "modal_edit_payment";
const MODAL_ID_EDIT_PHONE = "modal_edit_phone";
const MODAL_ID_ADD_ACCOUNT = "modal_add_account";

const CUSTOM_ID_VERIFY_BUTTON = "verify_account_button_v1";
const CUSTOM_ID_ADD_ACCOUNT_INPUT_BUTTON = "add_account_input_button_v2";
const CUSTOM_ID_EDIT_PAYMENT_PANEL_BUTTON = "edit_payment_panel_button_v2";
const CUSTOM_ID_EDIT_PHONE_PANEL_BUTTON = "edit_phone_panel_button_v2";

// ────────────────────────────────────────────────
// INITIALIZATION
// ────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const modalHandlers = new Collection();
const buttonHandlers = new Collection();

// ────────────────────────────────────────────────
// DATABASE & EMAIL FUNCTIONS
// ────────────────────────────────────────────────

async function supabase_get_user_data(discord_id) {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_USERS_TABLE)
      .select("*")
      .eq("discord_id", discord_id)
      .limit(1);
    if (error) {
      console.error("Supabase Get Error:", error.message);
      return null;
    }
    return data?.[0] || null;
  } catch (e) {
    console.error("Supabase Get Exception:", e.message);
    return null;
  }
}

async function supabase_update_user_data(discord_id, data) {
  const upsert_data = { ...data, discord_id };
  const filtered = Object.fromEntries(
    Object.entries(upsert_data).filter(([_, v]) => v !== undefined),
  );

  if (Object.keys(filtered).length <= 1) return false;

  try {
    const { error } = await supabase
      .from(SUPABASE_USERS_TABLE)
      .upsert(filtered, { onConflict: "discord_id" });
    if (error) {
      console.error("Supabase Upsert Error:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Supabase Upsert Exception:", e.message);
    return false;
  }
}

async function _send_verification_email(email, code) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: "Ternak Klip Discord Verification Code",
    text: `Your 6-digit verification code: ${code}. Valid for 1 hour.`,
    html: `<h1>Ternak Klip Verification</h1><p>Your code: <b>${code}</b>. Valid for 1 hour.</p>`,
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error(`Email failed to ${email}:`, error.message);
    return false;
  }
}

// ────────────────────────────────────────────────
// CORE REGISTRATION LOGIC
// ────────────────────────────────────────────────

async function _execute_add_account_logic(
  user,
  email,
  phone_number,
  send_func,
  ephemeral = false,
) {
  const kwargs = ephemeral ? { flags: EPHEMERAL_FLAG } : {};

  email = (email || "").trim();
  phone_number = (phone_number || "").trim();

  if (!email.includes("@") || phone_number.replace(/[\s+]/g, "").length < 6) {
    await send_func({
      content: "⚠️ Invalid email or phone number format.",
      ...kwargs,
    });
    return false;
  }

  const user_data = await supabase_get_user_data(user.id);
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const timestamp = new Date().toISOString();

  const data = {
    email,
    phone_number,
    discord_name: user.globalName || user.username,
    is_verified: false,
    verification_code: code,
    verification_timestamp: timestamp,
    registered_at: user_data?.registered_at || timestamp,
  };

  const success = await supabase_update_user_data(user.id, data);

  if (success && (await _send_verification_email(email, code))) {
    await send_func({
      content:
        `📬 Kode verifikasi telah dikirim ke **${email}**.\n\n` +
        `Masukkan kode 6 digit di tombol Verify Account di bawah ini.`,
      components: [getVerificationView()],
      ...kwargs,
    });
  } else {
    await send_func({
      content: "❌ Gagal menyimpan data atau mengirim email. Coba lagi.",
      ...kwargs,
    });
  }

  return success;
}

// ────────────────────────────────────────────────
// MODALS & VIEWS
// ────────────────────────────────────────────────

function getVerificationModal(userId) {
  return new ModalBuilder()
    .setCustomId(`${MODAL_ID_VERIFY}_${userId}`)
    .setTitle("Verifikasi Akun")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("verification_code_input")
          .setLabel("Kode Verifikasi (6 digit)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(6)
          .setMinLength(6),
      ),
    );
}

function getEditPaymentModal(userId) {
  return new ModalBuilder()
    .setCustomId(`${MODAL_ID_EDIT_PAYMENT}_${userId}`)
    .setTitle("Edit Nomor Pembayaran")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("dana_input")
          .setLabel("DANA")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("+62")
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("gopay_input")
          .setLabel("Gopay")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("+62")
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("mandiri_input")
          .setLabel("Mandiri")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Masukkan nomor rekening Mandiri")
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("bca_input")
          .setLabel("BCA")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Masukkan nomor rekening BCA")
          .setRequired(false),
      ),
    );
}

function getEditPhoneModal(userId) {
  return new ModalBuilder()
    .setCustomId(`${MODAL_ID_EDIT_PHONE}_${userId}`)
    .setTitle("Update Nomor Telepon")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("new_phone_input")
          .setLabel("Nomor Telepon (+62...)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20),
      ),
    );
}

function getAddAccountInputModal(userId) {
  return new ModalBuilder()
    .setCustomId(`${MODAL_ID_ADD_ACCOUNT}_${userId}`)
    .setTitle("Pendaftaran Akun")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("email_input")
          .setLabel("Email")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("phone_input")
          .setLabel("Nomor Telepon")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
}

function getVerificationView() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_VERIFY_BUTTON)
      .setLabel("Verify Account")
      .setStyle(ButtonStyle.Secondary),
  );
}

function getAddAccountInitiatorView() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_ADD_ACCOUNT_INPUT_BUTTON)
      .setLabel("📝 Daftar")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ────────────────────────────────────────────────
// HANDLER FUNCTIONS
// ────────────────────────────────────────────────

async function handleVerificationModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const submitted_code = interaction.fields
    .getTextInputValue("verification_code_input")
    .trim();

  const user_data = await supabase_get_user_data(interaction.user.id);

  // Cek data user ada dan belum verified
  if (!user_data || user_data.is_verified) {
    return interaction.followUp({
      content:
        "❌ Akun sudah terverifikasi atau data pendaftaran tidak ditemukan.",
      ephemeral: true,
    });
  }

  // Cek kode benar
  if (submitted_code !== user_data.verification_code) {
    return interaction.followUp({
      content: "❌ Kode verifikasi yang Anda masukkan salah.",
      ephemeral: true,
    });
  }

  // Cek masa berlaku kode
  const stored_ts = new Date(user_data.verification_timestamp).getTime();
  const current_ts = Date.now();
  if ((current_ts - stored_ts) / 1000 > VERIFICATION_CODE_EXPIRATION_SECONDS) {
    return interaction.followUp({
      content: "❌ Kode verifikasi sudah kadaluarsa. Silakan daftar ulang.",
      ephemeral: true,
    });
  }

  // Siapkan data update
  const update_data = {
    is_verified: true,
    verification_code: null,
    verification_timestamp: null,
    discord_name: interaction.user.globalName || interaction.user.username,
    // email dan phone_number tetap dipertahankan (opsional, bisa dihapus jika tidak perlu di-update ulang)
    email: user_data.email,
    phone_number: user_data.phone_number,
  };

  // Lakukan update dan tunggu hasilnya
  const update_success = await supabase_update_user_data(
    interaction.user.id,
    update_data,
  );

  if (!update_success) {
    console.error(
      `[VERIF ERROR] Gagal update is_verified untuk user ${interaction.user.id}`,
    );
    return interaction.followUp({
      content:
        "❌ Verifikasi gagal: Tidak dapat menyimpan status ke database. Hubungi admin.",
      ephemeral: true,
    });
  }

  console.log(
    `[VERIF SUCCESS] User ${interaction.user.id} (${interaction.user.tag}) berhasil diverifikasi`,
  );

  // Assign role (jika ada)
  const guild = interaction.guild;
  const role = guild?.roles.cache.find((r) => r.name === REGISTERED_ROLE_NAME);

  let role_message = "";
  if (role && interaction.member) {
    try {
      await interaction.member.roles.add(role);
      role_message = `✅ Role **${REGISTERED_ROLE_NAME}** telah diberikan.`;
    } catch (err) {
      console.error("Gagal assign role:", err.message);
      role_message = "⚠️ Gagal memberikan role. Periksa permission bot.";
    }
  } else {
    role_message = "⚠️ Role tidak ditemukan atau bot tidak punya izin.";
  }

  // Balas sukses ke user
  await interaction.followUp({
    content:
      `🎉 **Verifikasi Berhasil!**\n\n` +
      `Selamat datang, ${interaction.user.globalName || interaction.user.username}!\n` +
      `${role_message}\n\n` +
      `Status Anda sekarang **VERIFIED**. Silakan cek di web.`,
    ephemeral: true,
  });
}

async function handleEditPaymentModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const user = interaction.user;
  const user_data = await supabase_get_user_data(user.id);

  if (!user_data || !user_data.is_verified) {
    return interaction.followUp({
      content: "Harus verifikasi terlebih dahulu.",
      ephemeral: true,
    });
  }

  const update = {
    email: user_data.email,
    phone_number: user_data.phone_number,
    discord_name: user.globalName || user.username,
  };

  const fields = ["dana_input", "gopay_input", "mandiri_input", "bca_input"];
  let changed = false;

  for (const field of fields) {
    const value = interaction.fields.getTextInputValue(field)?.trim();
    if (value) {
      update[field.split("_")[0] + "_number"] = value;
      changed = true;
    }
  }

  if (!changed) {
    return interaction.followUp({
      content: "Tidak ada perubahan yang dimasukkan.",
      ephemeral: true,
    });
  }

  const success = await supabase_update_user_data(user.id, update);

  await interaction.followUp({
    content: success
      ? "✅ Data pembayaran berhasil diperbarui."
      : "❌ Gagal menyimpan data.",
    ephemeral: true,
  });
}

async function handleEditPhoneModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const user = interaction.user;
  const user_data = await supabase_get_user_data(user.id);

  if (!user_data || !user_data.is_verified) {
    return interaction.followUp({
      content: "Harus verifikasi terlebih dahulu.",
      ephemeral: true,
    });
  }

  const new_phone = interaction.fields
    .getTextInputValue("new_phone_input")
    .trim();

  if (new_phone.replace(/[\s+]/g, "").length < 8) {
    return interaction.followUp({
      content: "Nomor telepon tidak valid.",
      ephemeral: true,
    });
  }

  const success = await supabase_update_user_data(user.id, {
    phone_number: new_phone,
    discord_name: user.globalName || user.username,
  });

  await interaction.followUp({
    content: success
      ? `✅ Nomor telepon diperbarui menjadi: **${new_phone}**`
      : "❌ Gagal menyimpan nomor telepon.",
    ephemeral: true,
  });
}

async function handleAddAccountModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const email = interaction.fields.getTextInputValue("email_input").trim();
  const phone = interaction.fields.getTextInputValue("phone_input").trim();

  await _execute_add_account_logic(
    interaction.member || interaction.user,
    email,
    phone,
    interaction.followUp.bind(interaction),
    true,
  );
}

async function handleVerifyButton(interaction) {
  const data = await supabase_get_user_data(interaction.user.id);
  if (data && !data.is_verified) {
    await interaction.showModal(getVerificationModal(interaction.user.id));
  } else {
    await interaction.reply({
      content: data?.is_verified
        ? "Sudah terverifikasi!"
        : "Daftar dulu dengan !add-account",
      ephemeral: true,
    });
  }
}

async function handleEditPaymentButton(interaction) {
  try {
    const user_data = await supabase_get_user_data(interaction.user.id);

    if (!user_data || !user_data.is_verified) {
      return interaction.reply({
        content:
          "❌ Anda harus terverifikasi terlebih dahulu untuk mengedit detail pembayaran.",
        ephemeral: true,
      });
    }

    // Langsung tampilkan modal — TANPA deferUpdate
    await interaction.showModal(getEditPaymentModal(interaction.user.id));
  } catch (err) {
    console.error("[EDIT PAYMENT BUTTON ERROR]", err);
    if (!interaction.replied) {
      await interaction
        .reply({
          content: "Terjadi kesalahan saat membuka form edit pembayaran.",
          ephemeral: true,
        })
        .catch(() => {});
    }
  }
}

async function handleEditPhoneButton(interaction) {
  try {
    const user_data = await supabase_get_user_data(interaction.user.id);

    if (!user_data || !user_data.is_verified) {
      return interaction.reply({
        content:
          "❌ Anda harus terverifikasi terlebih dahulu untuk mengedit nomor telepon.",
        ephemeral: true,
      });
    }

    // Langsung tampilkan modal — TANPA deferUpdate
    await interaction.showModal(getEditPhoneModal(interaction.user.id));
  } catch (err) {
    console.error("[EDIT PHONE BUTTON ERROR]", err);
    if (!interaction.replied) {
      await interaction
        .reply({
          content: "Terjadi kesalahan saat membuka form edit nomor telepon.",
          ephemeral: true,
        })
        .catch(() => {});
    }
  }
}

async function handleAddAccountInitiatorButton(interaction) {
  await interaction.showModal(getAddAccountInputModal(interaction.user.id));
}

// ────────────────────────────────────────────────
// REGISTER HANDLERS
// ────────────────────────────────────────────────

modalHandlers.set(`${MODAL_ID_VERIFY}_`, handleVerificationModal);
modalHandlers.set(`${MODAL_ID_EDIT_PAYMENT}_`, handleEditPaymentModal);
modalHandlers.set(`${MODAL_ID_EDIT_PHONE}_`, handleEditPhoneModal);
modalHandlers.set(`${MODAL_ID_ADD_ACCOUNT}_`, handleAddAccountModal);

buttonHandlers.set(CUSTOM_ID_VERIFY_BUTTON, handleVerifyButton);
buttonHandlers.set(
  CUSTOM_ID_EDIT_PAYMENT_PANEL_BUTTON,
  handleEditPaymentButton,
);
buttonHandlers.set(CUSTOM_ID_EDIT_PHONE_PANEL_BUTTON, handleEditPhoneButton);
buttonHandlers.set(
  CUSTOM_ID_ADD_ACCOUNT_INPUT_BUTTON,
  handleAddAccountInitiatorButton,
);

// ────────────────────────────────────────────────
// EVENTS
// ────────────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`Bot online sebagai ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const handler = buttonHandlers.get(interaction.customId);
      if (handler) return await handler(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      const baseId =
        interaction.customId.split("_").slice(0, -1).join("_") + "_";
      const handler = modalHandlers.get(baseId);
      if (handler) return await handler(interaction);
      return;
    }
  } catch (err) {
    console.error("[INTERACTION ERROR]", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "Terjadi kesalahan. Coba lagi nanti.",
          ephemeral: true,
        })
        .catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const userMsgLower = content.toLowerCase();

  // ────────────────────────────────────────────────
  // 1. LOGIKA COMMANDS (PREFIX !)
  // ────────────────────────────────────────────────
  if (content.startsWith(PREFIX)) {
    const args = content.slice(PREFIX.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();

    // Command: !add-account (Pendaftaran)
    if (commandName === "add-account") {
      if (message.deletable) {
        await message.delete().catch(() => {});
      }

      const embed = new EmbedBuilder()
        .setTitle("📝 Formulir Pendaftaran")
        .setDescription(
          "Silakan klik tombol di bawah ini untuk membuka formulir dan memasukkan data Anda seperti **Email, Phone Number**.\n\n" +
            "**Kode verifikasi akan dikirimkan ke alamat email yang Anda berikan.**\n" +
            "[www.ternakklip.com](http://www.ternakklip.com) | Ternak Klip",
        )
        .setColor(0xffffff)
        .setImage(
          "https://media.discordapp.net/attachments/1421028875089215500/1451167107168342059/Member_Registration.png?ex=6945302f&is=6943deaf&hm=f9f8c2db505e1867007f59386f15f5cbbf4df26b0896cc9806ec13ea4f4d29a8&=&format=webp&quality=lossless&width=2256&height=706",
        );

      return message.channel.send({
        embeds: [embed],
        components: [getAddAccountInitiatorView()],
      });
    }

    // Command: !users (Panel Kelola Akun)
    if (commandName === "users") {
      if (message.deletable) {
        await message.delete().catch(() => {});
      }

      const user_data = await supabase_get_user_data(message.author.id);

      const embed = new EmbedBuilder().setColor(0xffffff);
      let components = [];

      const editPaymentBtn = new ButtonBuilder()
        .setCustomId(CUSTOM_ID_EDIT_PAYMENT_PANEL_BUTTON)
        .setLabel("Edit Payment")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("💳");

      const editPhoneBtn = new ButtonBuilder()
        .setCustomId(CUSTOM_ID_EDIT_PHONE_PANEL_BUTTON)
        .setLabel("Edit Phone Number")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("📱");

      const panelRow = new ActionRowBuilder().addComponents(
        editPaymentBtn,
        editPhoneBtn,
      );

      if (user_data && user_data.is_verified) {
        embed
          .setTitle("⚙️ User Account Management")
          .setDescription(
            "Gunakan tombol di bawah ini untuk mengupdate detail akun Anda.",
          )
          .addFields(
            {
              name: "💳 Edit Payment",
              value: "Update nomor DANA, Gopay, Mandiri, BCA (semua opsional).",
              inline: true,
            },
            {
              name: "📱 Edit Phone Number",
              value: "Update nomor kontak Anda.",
              inline: true,
            },
          );

        components = [panelRow];
      } else if (user_data && !user_data.is_verified) {
        embed
          .setTitle("⚠️ Account Not Verified")
          .setDescription(
            "**Status: ❌ Menunggu Verifikasi**\n\n" +
              "Anda harus **verifikasi** akun terlebih dahulu.\n" +
              "Cek email terdaftar untuk kode verifikasi.\n" +
              "Klik tombol di bawah untuk memasukkan kode.",
          )
          .setColor(0xffa500);

        components = [getVerificationView()];
      } else {
        embed
          .setTitle("⚠️ Account Not Registered")
          .setDescription(
            "**Status: ❌ Tidak Ditemukan**\n\n" +
              "Anda harus terdaftar terlebih dahulu.\n" +
              "Gunakan command `!add-account` atau tombol daftar.",
          )
          .setColor(0xff0000);
      }

      return message.channel.send({ embeds: [embed], components });
    }

    // Command: Dynamic Announcement dari tabel bot_settings
    const { data: cmdData, error: cmdErr } = await supabase
      .from("bot_settings")
      .select("*")
      .eq("command_name", commandName)
      .single();

    if (!cmdErr && cmdData) {
      if (message.deletable) {
        await message.delete().catch(() => {});
      }

      const embed = new EmbedBuilder()
        .setColor(
          parseInt((cmdData.hex_color || "#5865f2").replace("#", ""), 16),
        )
        .setTimestamp();

      if (isValidString(cmdData.title)) embed.setTitle(cmdData.title.trim());
      if (isValidString(cmdData.description))
        embed.setDescription(cmdData.description.trim());
      if (cmdData.thumbnail_url) embed.setThumbnail(cmdData.thumbnail_url);
      if (cmdData.image_url) embed.setImage(cmdData.image_url);

      const components = [];
      if (
        isValidString(cmdData.button_label) &&
        isValidString(cmdData.button_url)
      ) {
        const btn = new ButtonBuilder()
          .setLabel(cmdData.button_label)
          .setStyle(ButtonStyle.Link)
          .setURL(cmdData.button_url);
        if (cmdData.button_emoji) btn.setEmoji(cmdData.button_emoji);
        components.push(new ActionRowBuilder().addComponents(btn));
      }

      const hasEmbedContent =
        embed.data.title ||
        embed.data.description ||
        embed.data.thumbnail ||
        embed.data.image;

      return message.channel.send({
        content: cmdData.message_content || "",
        embeds: hasEmbedContent ? [embed] : [],
        components,
      });
    }
  }

  // ────────────────────────────────────────────────
  // 2. AUTO RESPONSE / TRIGGERS (dari tabel bot_triggers)
  // ────────────────────────────────────────────────
  const { data: allTriggers } = await supabase.from("bot_triggers").select("*");
  if (allTriggers && allTriggers.length > 0) {
    const matched = allTriggers.find((t) => {
      const kw = t.trigger_text.toLowerCase().trim();
      return t.match_type === "Exact"
        ? userMsgLower === kw
        : userMsgLower.includes(kw);
    });

    if (matched) {
      const payload = { content: matched.response_text || "" };

      if (matched.embed_enabled && matched.embed_data) {
        const ed = matched.embed_data;
        const emb = new EmbedBuilder().setColor(
          parseInt((ed.color || "#5865f2").replace("#", ""), 16),
        );

        if (isValidString(ed.title)) emb.setTitle(ed.title.trim());
        if (isValidString(ed.description))
          emb.setDescription(ed.description.trim());
        if (ed.image) emb.setImage(ed.image);
        if (ed.thumbnail) emb.setThumbnail(ed.thumbnail);

        if (emb.data.title || emb.data.description) {
          payload.embeds = [emb];
        }
      }

      if (payload.content || payload.embeds) {
        return message.reply(payload).catch(() => {});
      }
    }
  }
});

// ────────────────────────────────────────────────
// START BOT
// ────────────────────────────────────────────────

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN tidak ditemukan di .env");
  process.exit(1);
}

client.login(BOT_TOKEN).catch((err) => {
  console.error("Login gagal:", err.message);
  process.exit(1);
});
