const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");
const axios = require("axios");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ✅ TOKEN FROM ENV (SAFE)
const BOT_TOKEN = process.env.BOT_TOKEN;

// ================== STATE ==================
let LAST_MATCH_ID = null;
let CACHED_SCORECARD = null;
let SCORECARD_FETCHED = false;
const RESET_AFTER_MS = 60 * 60 * 1000;

// ================== CRICBUZZ ==================
const HEADERS = {
  "User-Agent": "Mozilla/5.0",
  "Referer": "https://www.cricbuzz.com"
};

const COMM_URL = id => `https://www.cricbuzz.com/api/mcenter/comm/${id}`;
const SCORECARD_URL = id => `https://www.cricbuzz.com/api/mcenter/scorecard/${id}`;

// ================== READY ==================
client.once("ready", async () => {
  console.log("SUPERIOR Cricket Bot Online 🏏");

  await client.application.commands.set([
    new SlashCommandBuilder()
      .setName("live")
      .setDescription("Show live cricket match")
      .addStringOption(o =>
        o.setName("matchid")
          .setDescription("Cricbuzz Match ID")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("current")
      .setDescription("Show current match again")
  ]);
});

// ================== FETCH ==================
async function fetchComm(id) {
  const res = await axios.get(COMM_URL(id), { headers: HEADERS, timeout: 15000 });
  return res.data;
}

async function fetchScorecard(id) {
  const res = await axios.get(SCORECARD_URL(id), { headers: HEADERS, timeout: 15000 });
  return res.data;
}

// ================== UTIL ==================
function shouldReset(header) {
  if (!header?.matchCompleteTimeGMT) return false;
  return Date.now() - new Date(header.matchCompleteTimeGMT).getTime() > RESET_AFTER_MS;
}

function noLiveEmbed() {
  return new EmbedBuilder()
    .setTitle("🏏 Live Cricket")
    .setDescription("⌛ No live match is streaming right now.")
    .setColor(0x9e9e9e);
}

// ================== MAIN EMBED ==================
function buildMainEmbed(data) {
  const h = data.matchHeader;
  const m = data.miniscore;

  if (h.state === "Complete") {
    let scores = "";
    (m?.matchScoreDetails?.inningsScoreList || []).forEach(i => {
      scores += `**${i.batTeamName}** ${i.score}/${i.wickets} (${i.overs} ov)\n`;
    });

    return new EmbedBuilder()
      .setTitle("🏁 Match Result")
      .setDescription(
        `${scores || "Final scores unavailable"}\n` +
        `🏆 **Result:** ${h.status || "Result unavailable"}\n` +
        `🎖 **Player of the Match:** ${h.playersOfTheMatch?.[0]?.name || "Not announced"}`
      )
      .setColor(0xffc107);
  }

  return new EmbedBuilder()
    .setTitle(`${h.team1.shortName} vs ${h.team2.shortName}`)
    .setDescription(
      `**${m.batTeam.teamName} ${m.batTeam.teamScore}/${m.batTeam.teamWkts}**\n` +
      `Overs: ${m.overs}\n\n${h.status}`
    )
    .setColor(0x4caf50);
}

// ================== COMPONENTS ==================
function components(matchId, ended) {
  const options = [
    { label: "Scorecard", value: "scorecard", emoji: "🏏" },
    { label: "Batting", value: "batting", emoji: "🏃" },
    { label: "Bowling", value: "bowling", emoji: "🎯" }
  ];
  if (ended) options.push({ label: "Full Scorecard", value: "full", emoji: "📊" });

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`view_${matchId}`)
        .setPlaceholder("Choose view")
        .addOptions(options)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`refresh_${matchId}`)
        .setLabel("Refresh")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

// ================== BEST PERFORMANCE ==================
function getBestBatter(scorecard, team) {
  let best = null;
  (scorecard.scoreCard || []).forEach(inn => {
    if (inn.batTeamDetails?.batTeamName !== team) return;
    Object.values(inn.batTeamDetails.batsmenData || {}).forEach(b => {
      if (!best || b.runs > best.runs || (b.runs === best.runs && b.balls < best.balls)) {
        best = b;
      }
    });
  });
  return best;
}

function getBestBowler(scorecard, team) {
  let best = null;
  (scorecard.scoreCard || []).forEach(inn => {
    if (inn.bowlTeamDetails?.bowlTeamName !== team) return;
    Object.values(inn.bowlTeamDetails.bowlersData || {}).forEach(b => {
      if (!best || b.wickets > best.wickets) best = b;
    });
  });
  return best;
}

// ================== INTERACTIONS ==================
client.on("interactionCreate", async i => {
  try {
    if (i.isChatInputCommand()) {
      await i.deferReply();

      if (i.commandName === "live") {
        LAST_MATCH_ID = i.options.getString("matchid");
        CACHED_SCORECARD = null;
        SCORECARD_FETCHED = false;
      }

      if (i.commandName === "current" && !LAST_MATCH_ID) {
        return i.editReply("❌ No active match. Use `/live` first.");
      }

      const data = await fetchComm(LAST_MATCH_ID);
      const h = data.matchHeader;

      if (h.state === "Complete" && !SCORECARD_FETCHED) {
        try {
          CACHED_SCORECARD = await fetchScorecard(LAST_MATCH_ID);
          SCORECARD_FETCHED = true;
        } catch {}
      }

      if (h.state === "Complete" && shouldReset(h)) {
        return i.editReply({ embeds: [noLiveEmbed()], components: [] });
      }

      return i.editReply({
        embeds: [buildMainEmbed(data)],
        components: components(LAST_MATCH_ID, h.state === "Complete")
      });
    }

    if (i.isStringSelectMenu()) {
      await i.deferUpdate();
      const matchId = i.customId.split("_")[1];
      const view = i.values[0];

      const data = await fetchComm(matchId);
      const h = data.matchHeader;
      const m = data.miniscore;

      if (h.state === "Complete" && shouldReset(h)) {
        return i.editReply({ embeds: [noLiveEmbed()], components: [] });
      }

      if (view === "scorecard") {
        return i.editReply({
          embeds: [buildMainEmbed(data)],
          components: components(matchId, h.state === "Complete")
        });
      }

      if (view === "full" && h.state === "Complete" && CACHED_SCORECARD) {
        let text = "";
        (CACHED_SCORECARD.scoreCard || []).forEach(inn => {
          text += `🏏 **${inn.batTeamDetails.batTeamName}**\n`;
          Object.values(inn.batTeamDetails.batsmenData || {}).forEach(b => {
            text += `${b.batName} ${b.runs} (${b.balls})\n`;
          });
          text += "\n";
        });

        return i.editReply({
          embeds: [new EmbedBuilder().setTitle("📊 Full Scorecard").setDescription(text || "Unavailable").setColor(0x009688)],
          components: components(matchId, true)
        });
      }

      if (view === "batting") {
        if (h.state !== "Complete") {
          let desc = "";
          if (m.batsmanStriker)
            desc += `**${m.batsmanStriker.name}** ${m.batsmanStriker.runs} (${m.batsmanStriker.balls})\n`;
          if (m.batsmanNonStriker)
            desc += `**${m.batsmanNonStriker.name}** ${m.batsmanNonStriker.runs} (${m.batsmanNonStriker.balls})`;

          return i.editReply({
            embeds: [new EmbedBuilder().setTitle("🏏 Batting").setDescription(desc || "Batting data unavailable").setColor(0x2196f3)],
            components: components(matchId, false)
          });
        }

        const winner = h.result?.winningTeam || h.status?.split(" won")[0];
        const best = getBestBatter(CACHED_SCORECARD, winner);

        return i.editReply({
          embeds: [new EmbedBuilder().setTitle("🏏 Batting Highlights").setDescription(
            best ? `🥇 **Best Batter (${winner})**\n${best.batName} – ${best.runs} (${best.balls})` : "Unavailable"
          ).setColor(0x2196f3)],
          components: components(matchId, true)
        });
      }

      if (view === "bowling") {
        if (h.state !== "Complete") {
          return i.editReply({
            embeds: [new EmbedBuilder().setTitle("🎯 Bowling").setDescription(
              `**${m.bowlerStriker?.name || "?"}**\nOvers: ${m.bowlerStriker?.overs || 0}\nRuns: ${m.bowlerStriker?.runs || 0}\nWickets: ${m.bowlerStriker?.wickets || 0}`
            ).setColor(0xff5722)],
            components: components(matchId, false)
          });
        }

        const winner = h.result?.winningTeam || h.status?.split(" won")[0];
        const best = getBestBowler(CACHED_SCORECARD, winner);

        return i.editReply({
          embeds: [new EmbedBuilder().setTitle("🎯 Bowling Highlights").setDescription(
            best ? `🥇 **Best Bowler (${winner})**\n${best.bowlName} – ${best.wickets}/${best.runs} (${best.overs} ov)` : "Unavailable"
          ).setColor(0xff5722)],
          components: components(matchId, true)
        });
      }
    }

    if (i.isButton() && i.customId.startsWith("refresh_")) {
      await i.deferUpdate();
      const matchId = i.customId.split("_")[1];
      const data = await fetchComm(matchId);
      const h = data.matchHeader;

      if (h.state === "Complete" && shouldReset(h)) {
        return i.editReply({ embeds: [noLiveEmbed()], components: [] });
      }

      return i.editReply({
        embeds: [buildMainEmbed(data)],
        components: components(matchId, h.state === "Complete")
      });
    }
  } catch (err) {
    console.error(err);
  }
});

// ================== SAFETY ==================
process.on("unhandledRejection", () => {});
client.on("error", () => {});

console.log("TOKEN EXISTS:", !!process.env.TOKEN);
client.login(process.env.TOKEN);



