// ================================================
// Grand Mobile RP — Discord Moderation Bot
// Single File Version (Mobile Friendly)
// ================================================

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, Collection,
  Events, ActivityType, EmbedBuilder,
  SlashCommandBuilder, PermissionFlagsBits, REST, Routes
} = require('discord.js');

// ================================================
// DATABASE (in-memory, no SQLite needed)
// ================================================
const warningsDB = {}; // { "guildId-userId": [ {reason, moderatorId, timestamp} ] }
const punishmentsDB = {};

function getKey(userId, guildId) { return `${guildId}-${userId}`; }

function addWarning(userId, guildId, reason, moderatorId) {
  const key = getKey(userId, guildId);
  if (!warningsDB[key]) warningsDB[key] = [];
  warningsDB[key].push({ reason, moderatorId, timestamp: Date.now() });
}

function getWarnings(userId, guildId) {
  return warningsDB[getKey(userId, guildId)] || [];
}

function getWarningCount(userId, guildId) {
  return getWarnings(userId, guildId).length;
}

function clearWarnings(userId, guildId) {
  warningsDB[getKey(userId, guildId)] = [];
}

function logPunishment(userId, guildId, type, reason, duration, moderatorId) {
  const key = getKey(userId, guildId);
  if (!punishmentsDB[key]) punishmentsDB[key] = [];
  punishmentsDB[key].push({ type, reason, duration, moderatorId, timestamp: Date.now() });
}

// ================================================
// DETECTION ENGINE
// ================================================
const PROFANITY_LIST = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'crap', 'piss',
  'dick', 'cock', 'pussy', 'cunt', 'whore', 'slut', 'faggot',
  'retard', 'dumbass', 'motherfucker',
];

const HATE_SPEECH_LIST = [
  'nigger', 'nigga', 'chink', 'spic', 'kike', 'raghead', 'towelhead',
  'gook', 'wetback', 'beaner', 'nazi', 'heil', 'white power',
];

const INSULT_PATTERNS = [
  /\b(you('re| are)\s+)(stupid|dumb|idiot|moron|trash|worthless|loser|pathetic|garbage|useless)\b/i,
  /\b(go\s+(die|kill yourself|kys))\b/i,
  /\b(shut\s+up)\b/i,
];

const FAMILY_INSULT_PATTERNS = [
  /\b(your\s+(mom|mother|dad|father|sister|brother|family|parents?|relative|uncle|aunt|grandma|grandpa))\s*(is|are|was|were)?\s*(stupid|dumb|trash|ugly|fat|bitch|whore|slut|dead|idiot)/i,
  /\bmotherfuck/i,
];

const LINK_REGEX = /https?:\/\/\S+|discord\.gg\/\S+|discord\.com\/invite\/\S+/gi;
const ALLOWED_DOMAINS = []; // add your whitelisted domains here e.g. 'grnd.gg'
const NON_LATIN_REGEX = /[\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0900-\u097F]/;
const EMOJI_LIMIT = 5;
const MENTION_LIMIT = 3;

function checkMessage(message) {
  const content = message.content;
  const lower = content.toLowerCase();
  const violations = [];

  // Family insult (highest priority)
  if (FAMILY_INSULT_PATTERNS.some(p => p.test(content))) {
    return [{ type: 'FAMILY_INSULT', reason: 'Message contains family insults (Rule 1.9)', severity: 'HIGH' }];
  }

  // Hate speech
  if (HATE_SPEECH_LIST.some(w => lower.includes(w))) {
    violations.push({ type: 'HATE_SPEECH', reason: 'Hate speech or discrimination is prohibited (Rule 1.10)', severity: 'HIGH' });
  }

  // Profanity
  if (PROFANITY_LIST.some(w => new RegExp(`\\b${w}\\b`).test(lower.replace(/[^a-z0-9\s]/g, '')))) {
    violations.push({ type: 'PROFANITY', reason: 'Profanity is prohibited (Rule 1.1)', severity: 'MEDIUM' });
  }

  // Insults
  if (INSULT_PATTERNS.some(p => p.test(content))) {
    violations.push({ type: 'INSULT', reason: 'Insulting other users is prohibited (Rule 1.9)', severity: 'MEDIUM' });
  }

  // Advertising
  const links = content.match(LINK_REGEX) || [];
  if (links.some(link => !ALLOWED_DOMAINS.some(d => link.toLowerCase().includes(d)))) {
    violations.push({ type: 'ADVERTISING', reason: 'Advertising third-party links is prohibited (Rule 1.6)', severity: 'MEDIUM' });
  }

  // Non-English
  if (content.trim().length >= 5 && NON_LATIN_REGEX.test(content)) {
    violations.push({ type: 'NON_ENGLISH', reason: 'Only English is allowed (Rule 1.16)', severity: 'MEDIUM' });
  }

  // Spam
  if (/(.)\1{6,}/.test(content) || content.replace(/\s/g, '').length < 3) {
    violations.push({ type: 'SPAM', reason: 'Spam or low-quality messages are prohibited (Rule 1.2)', severity: 'LOW' });
  }

  // Excessive emojis
  const emojiMatches = content.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic}|<a?:\w+:\d+>)/gu) || [];
  if (emojiMatches.length > EMOJI_LIMIT) {
    violations.push({ type: 'EXCESSIVE_EMOJI', reason: 'Excessive use of emojis is prohibited (Rule 1.3)', severity: 'LOW' });
  }

  // Excessive mentions
  if (message.mentions.users.size + message.mentions.roles.size > MENTION_LIMIT) {
    violations.push({ type: 'EXCESSIVE_TAGS', reason: 'Excessive tagging is prohibited (Rule 1.3)', severity: 'LOW' });
  }

  // Caps / formatting
  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 10 && (content.match(/[A-Z]/g) || []).length / letters.length > 0.33) {
    violations.push({ type: 'FORMATTING', reason: 'Excessive caps lock is prohibited (Rule 1.4)', severity: 'LOW' });
  }

  // Admin tag without reason
  if ((message.mentions.roles.size || message.mentions.users.size) &&
      message.content.replace(/<@[!&]?\d+>/g, '').trim().length < 15) {
    violations.push({ type: 'ADMIN_TAG', reason: 'Tagging admin without a valid reason is prohibited (Rule 1.14)', severity: 'LOW' });
  }

  return violations;
}

// ================================================
// PUNISHMENT HELPERS
// ================================================
const DURATIONS = {
  MIN_60: 60 * 60 * 1000,
  HR_24:  24 * 60 * 60 * 1000,
  DAYS_7: 7 * 24 * 60 * 60 * 1000,
};

function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} minute(s)`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour(s)`;
  return `${Math.floor(h / 24)} day(s)`;
}

function parseDuration(str) {
  const match = str.match(/^(\d+)(m|h|d|w)$/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const multipliers = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return val * multipliers[match[2].toLowerCase()];
}

function getPunishment(type, warningCount) {
  const escalate = warningCount >= 3;
  const map = {
    PROFANITY:       { action: 'timeout', duration: DURATIONS.MIN_60 },
    SPAM:            { action: 'timeout', duration: escalate ? DURATIONS.HR_24 : DURATIONS.MIN_60 },
    EXCESSIVE_EMOJI: { action: 'timeout', duration: escalate ? DURATIONS.HR_24 : DURATIONS.MIN_60 },
    EXCESSIVE_TAGS:  { action: 'timeout', duration: escalate ? DURATIONS.HR_24 : DURATIONS.MIN_60 },
    FORMATTING:      { action: 'timeout', duration: DURATIONS.MIN_60 },
    ADVERTISING:     { action: escalate ? 'ban' : 'timeout', duration: DURATIONS.HR_24 },
    INSULT:          { action: escalate ? 'ban' : 'timeout', duration: DURATIONS.HR_24 },
    FAMILY_INSULT:   { action: escalate ? 'ban' : 'timeout', duration: DURATIONS.DAYS_7 },
    HATE_SPEECH:     { action: escalate ? 'ban' : 'timeout', duration: DURATIONS.HR_24 },
    NON_ENGLISH:     { action: 'timeout', duration: escalate ? DURATIONS.DAYS_7 : DURATIONS.HR_24 },
    ADMIN_TAG:       { action: 'timeout', duration: DURATIONS.HR_24 },
  };
  return map[type] || { action: 'warn', duration: null };
}

function buildDMEmbed(title, reason, duration, guildName) {
  return new EmbedBuilder()
    .setTitle(title).setColor(0xFF4444)
    .addFields(
      { name: '📋 Reason', value: reason },
      { name: '⏳ Duration', value: duration },
      { name: '🏠 Server', value: guildName }
    )
    .setFooter({ text: 'Grand Mobile RP Moderation' }).setTimestamp();
}

function buildLogEmbed(member, type, reason, duration, moderatorId) {
  return new EmbedBuilder()
    .setTitle(`🔴 ${type}`)
    .setColor(type === 'BAN' ? 0x8B0000 : type.includes('WARNING') ? 0xFFA500 : 0xFF4444)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: '👤 User', value: `${member.user.tag} (${member.id})`, inline: true },
      { name: '🤖 Moderator', value: moderatorId === 'AUTOMOD' ? 'AutoMod' : `<@${moderatorId}>`, inline: true },
      { name: '📋 Reason', value: reason },
      { name: '⏳ Duration', value: duration },
    )
    .setFooter({ text: 'Grand Mobile RP Moderation Log' }).setTimestamp();
}

async function doTimeout(member, durationMs, reason, logChannel, moderatorId = 'AUTOMOD') {
  try {
    await member.timeout(durationMs, reason);
    logPunishment(member.id, member.guild.id, 'TIMEOUT', reason, durationMs, moderatorId);
    const dur = formatDuration(durationMs);
    try { await member.send({ embeds: [buildDMEmbed('⏱️ You have been timed out', reason, dur, member.guild.name)] }); } catch (_) {}
    if (logChannel) await logChannel.send({ embeds: [buildLogEmbed(member, 'TIMEOUT', reason, dur, moderatorId)] });
  } catch (err) { console.error('[Timeout Error]', err.message); }
}

async function doBan(member, reason, logChannel, moderatorId = 'AUTOMOD') {
  try {
    await member.ban({ reason });
    logPunishment(member.id, member.guild.id, 'BAN', reason, null, moderatorId);
    try { await member.send({ embeds: [buildDMEmbed('🔨 You have been banned', reason, 'Permanent', member.guild.name)] }); } catch (_) {}
    if (logChannel) await logChannel.send({ embeds: [buildLogEmbed(member, 'BAN', reason, 'Permanent', moderatorId)] });
  } catch (err) { console.error('[Ban Error]', err.message); }
}

async function doWarn(member, reason, logChannel, moderatorId = 'AUTOMOD') {
  addWarning(member.id, member.guild.id, reason, moderatorId);
  const count = getWarningCount(member.id, member.guild.id);
  try {
    await member.send({ embeds: [buildDMEmbed(
      `⚠️ Warning #${count}`, reason,
      count >= 3 ? 'Escalated punishment incoming!' : `${3 - count} warning(s) until escalation`,
      member.guild.name
    )] });
  } catch (_) {}
  if (logChannel) await logChannel.send({ embeds: [buildLogEmbed(member, `WARNING #${count}`, reason, `${count}/3`, moderatorId)] });
  return count;
}

// ================================================
// SERVER RULES — Reason & Punishment Presets
// ================================================
const RULE_CHOICES = [
  { name: '1.1 — Profanity / Inappropriate Behavior',         value: '1.1_PROFANITY' },
  { name: '1.2 — Spam / Low-Quality / Off-Topic Message',     value: '1.2_SPAM' },
  { name: '1.3 — Excessive Emojis or Tags',                   value: '1.3_EMOJI' },
  { name: '1.4 — Caps Lock / Bold / Italic / Underline',      value: '1.4_FORMATTING' },
  { name: '1.5 — Discussing Admin / Project Team Actions',    value: '1.5_ADMIN_DISCUSS' },
  { name: '1.6 — Advertising Third-Party / Discord Server',   value: '1.6_ADVERTISING' },
  { name: '1.7 — Misleading / Excessive Slang or Jargon',     value: '1.7_SLANG' },
  { name: '1.8 — Violent / Rude / Extremist Content',         value: '1.8_VIOLENT' },
  { name: '1.9 — Insulting a User or Administrator',          value: '1.9_INSULT' },
  { name: '1.9 — Insulting Player / Admin Family',            value: '1.9_FAMILY_INSULT' },
  { name: '1.10 — Discrimination / Racism / Hate Speech',     value: '1.10_DISCRIMINATION' },
  { name: '1.11 — Disrespectful National/Group Definitions',  value: '1.11_NATIONALITY' },
  { name: '1.12 — Posting Private Messages Without Consent',  value: '1.12_PRIVATE_MSG' },
  { name: '1.13 — Sharing Personal Information (Doxxing)',    value: '1.13_DOXX' },
  { name: '1.14 — Tagging Admin Without Valid Reason',        value: '1.14_ADMIN_TAG' },
  { name: '1.15 — Inappropriate Reactions / Profile Actions', value: '1.15_REACTIONS' },
  { name: '1.16 — Non-English Communication',                 value: '1.16_NON_ENGLISH' },
  { name: '3.1 — Voice Modifier Software',                    value: '3.1_VOICE_MOD' },
  { name: '3.2 — Strange / Annoying Sounds in VC',           value: '3.2_SOUNDS' },
  { name: '3.3 — Interfering With VC Communication',         value: '3.3_VC_INTERFERE' },
  { name: '3.4 — Shouting / Amplifying Mic',                 value: '3.4_MIC_SPAM' },
  { name: '4.1 — Unrelated Screenshot',                      value: '4.1_SCREENSHOT' },
  { name: '4.3 — Link Attached in Screenshot Channel',       value: '4.3_SS_LINK' },
  { name: '4.4 — Personal Info Shared in Screenshot Channel',value: '4.4_SS_PERSONAL' },
];

// Map rule value → default punishment
const RULE_PUNISHMENTS = {
  '1.1_PROFANITY':      { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '1.2_SPAM':           { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '1.3_EMOJI':          { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '1.4_FORMATTING':     { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '1.5_ADMIN_DISCUSS':  { action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
  '1.6_ADVERTISING':    { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '1.7_SLANG':          { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '1.8_VIOLENT':        { action: 'timeout', duration: 7 * 24 * 60 * 60 * 1000, label: 'Timeout 7 days' },
  '1.9_INSULT':         { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '1.9_FAMILY_INSULT':  { action: 'timeout', duration: 7 * 24 * 60 * 60 * 1000, label: 'Timeout 7 days' },
  '1.10_DISCRIMINATION':{ action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
  '1.11_NATIONALITY':   { action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
  '1.12_PRIVATE_MSG':   { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '1.13_DOXX':          { action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
  '1.14_ADMIN_TAG':     { action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
  '1.15_REACTIONS':     { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '1.16_NON_ENGLISH':   { action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
  '3.1_VOICE_MOD':      { action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
  '3.2_SOUNDS':         { action: 'timeout', duration: 60 * 60 * 1000,          label: 'Timeout 60 min' },
  '3.3_VC_INTERFERE':   { action: 'timeout', duration: 10 * 60 * 1000,          label: 'Timeout 10 min' },
  '3.4_MIC_SPAM':       { action: 'timeout', duration: 10 * 60 * 1000,          label: 'Timeout 10 min' },
  '4.1_SCREENSHOT':     { action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
  '4.3_SS_LINK':        { action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
  '4.4_SS_PERSONAL':    { action: 'timeout', duration: 24 * 60 * 60 * 1000,     label: 'Timeout 24 hrs' },
};

function getRuleLabel(ruleValue) {
  const found = RULE_CHOICES.find(r => r.value === ruleValue);
  return found ? found.name : ruleValue;
}

// ================================================
// SLASH COMMANDS
// ================================================
const commands = [
  new SlashCommandBuilder()
    .setName('punish')
    .setDescription('Punish a user for breaking a server rule')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('The user to punish').setRequired(true))
    .addStringOption(o =>
      o.setName('rule')
        .setDescription('Which rule was broken?')
        .setRequired(true)
        .addChoices(...RULE_CHOICES)
    )
    .addStringOption(o =>
      o.setName('punishment')
        .setDescription('Override the default punishment (leave empty for default)')
        .setRequired(false)
        .addChoices(
          { name: 'Timeout 10 minutes',  value: '10m' },
          { name: 'Timeout 60 minutes',  value: '60m' },
          { name: 'Timeout 24 hours',    value: '24h' },
          { name: 'Timeout 7 days',      value: '7d' },
          { name: 'BAN (permanent)',      value: 'ban' },
        )
    ),

  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('View all warnings for a user')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true)),

  new SlashCommandBuilder()
    .setName('clearwarnings')
    .setDescription('Clear all warnings for a user (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('User to clear').setRequired(true)),
];

// ================================================
// BOT CLIENT
// ================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Register commands on ready
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: 'Grand Mobile RP | Enforcing Rules', type: ActivityType.Watching }],
    status: 'online',
  });

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// Auto-mod
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const logChannel = message.guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
  const violations = checkMessage(message);
  if (violations.length === 0) return;

  const member = message.member;
  if (!member) return;
  if (member.permissions.has('Administrator') || member.permissions.has('ModerateMembers')) return;

  if (process.env.AUTO_DELETE_MESSAGES === 'true') {
    try { await message.delete(); } catch (_) {}
  }

  const violation = violations[0];
  const currentWarnings = getWarningCount(member.id, message.guild.id);
  const punishment = getPunishment(violation.type, currentWarnings);

  if (punishment.action === 'ban') {
    await doBan(member, violation.reason, logChannel);
  } else if (punishment.action === 'timeout') {
    const count = await doWarn(member, violation.reason, logChannel);
    const duration = count >= 3 ? punishment.duration * 2 : punishment.duration;
    await doTimeout(member, duration, `[${count >= 3 ? 'Escalated' : 'Auto'}] ${violation.reason}`, logChannel);
  } else {
    await doWarn(member, violation.reason, logChannel);
  }
});

// Slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const logChannel = interaction.guild.channels.cache.get(process.env.LOG_CHANNEL_ID);

  // /punish
  if (interaction.commandName === 'punish') {
    const target = interaction.options.getMember('user');
    const ruleValue = interaction.options.getString('rule');
    const overridePunishment = interaction.options.getString('punishment');

    if (!target) return interaction.reply({ content: '❌ User not found.', ephemeral: true });
    if (target.permissions.has('Administrator')) return interaction.reply({ content: '❌ Cannot punish an administrator.', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const ruleLabel = getRuleLabel(ruleValue);
    const reason = `Violation: ${ruleLabel}`;
    const defaultPunishment = RULE_PUNISHMENTS[ruleValue];

    // Override or use default
    if (overridePunishment === 'ban') {
      await doBan(target, reason, logChannel, interaction.user.id);
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('🔨 User Banned')
          .setColor(0x8B0000)
          .addFields(
            { name: '👤 User', value: `${target.user.tag}` },
            { name: '📋 Rule Broken', value: ruleLabel },
            { name: '⚖️ Punishment', value: 'Permanent Ban' },
          )
          .setTimestamp()
          .setFooter({ text: `Punished by ${interaction.user.tag}` })
        ],
      });
    }

    let durationMs;
    let durationLabel;

    if (overridePunishment) {
      durationMs = parseDuration(overridePunishment);
      durationLabel = formatDuration(durationMs);
    } else {
      durationMs = defaultPunishment.duration;
      durationLabel = defaultPunishment.label;
    }

    // Add warning and apply timeout
    addWarning(target.id, interaction.guild.id, reason, interaction.user.id);
    const warnCount = getWarningCount(target.id, interaction.guild.id);
    await doTimeout(target, durationMs, reason, logChannel, interaction.user.id);

    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('✅ Punishment Issued')
        .setColor(0xFF4444)
        .addFields(
          { name: '👤 User', value: `${target.user.tag}` },
          { name: '📋 Rule Broken', value: ruleLabel },
          { name: '⚖️ Punishment', value: durationLabel },
          { name: '⚠️ Total Warnings', value: `${warnCount}` },
        )
        .setTimestamp()
        .setFooter({ text: `Punished by ${interaction.user.tag}` })
      ],
    });
  }

  // /warnings
  if (interaction.commandName === 'warnings') {
    const target = interaction.options.getUser('user');
    const warns = getWarnings(target.id, interaction.guild.id);

    if (warns.length === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('⚠️ Warnings').setColor(0x00FF88)
          .setDescription(`**${target.tag}** has no warnings.`).setTimestamp()],
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder().setTitle(`⚠️ Warnings — ${target.tag}`)
      .setColor(0xFFA500).setDescription(`Total: **${warns.length}**`).setTimestamp()
      .setFooter({ text: 'Grand Mobile RP Moderation' });

    warns.slice(0, 10).forEach((w, i) => {
      embed.addFields({
        name: `#${i + 1} — <t:${Math.floor(w.timestamp / 1000)}:R>`,
        value: `📋 ${w.reason}\n🤖 ${w.moderatorId === 'AUTOMOD' ? 'AutoMod' : `<@${w.moderatorId}>`}`,
      });
    });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // /clearwarnings
  if (interaction.commandName === 'clearwarnings') {
    const target = interaction.options.getUser('user');
    const before = getWarningCount(target.id, interaction.guild.id);
    clearWarnings(target.id, interaction.guild.id);

    if (logChannel) {
      await logChannel.send({ embeds: [new EmbedBuilder().setTitle('🧹 Warnings Cleared').setColor(0x00BFFF)
        .addFields(
          { name: '👤 User', value: `${target.tag}`, inline: true },
          { name: '🗑️ Removed', value: `${before}`, inline: true },
          { name: '👮 By', value: `<@${interaction.user.id}>`, inline: true },
        ).setTimestamp()] });
    }

    return interaction.reply({
      embeds: [new EmbedBuilder().setTitle('✅ Warnings Cleared').setColor(0x00FF88)
        .setDescription(`Cleared **${before}** warning(s) for **${target.tag}**.`).setTimestamp()],
      ephemeral: true,
    });
  }
});

client.login(process.env.BOT_TOKEN);
