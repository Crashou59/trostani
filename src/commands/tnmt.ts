// tnmt.ts contains code to handle the tnmt command and tnmt subcommands

// Imports
import { Message, Client, Guild } from "discord.js";
import { Challonge, TournamentInterfaces, Tournament } from "challonge-ts";
import { MD5 } from "crypto-js";
import { Deck } from "../scry/mtg";
import { Manastack } from "../builders/manastack";
import {
  Command,
  parseArgs,
  isAuthorized,
  hasPermission,
  generateArgsErrorMsg,
  SearchResultTooLong,
  decklistFromAttachment,
} from "./utils";
import { generateSubcommandExample } from "./help";
import { setPriority } from "os";

// Functions
// tnmtHelpMessage is used to generate an help message for the tnmt command and subcommands
export function tnmtHelpMessage(cmd: Command): string {
  const message = `Using command \`${cmd.prefix}tnmt\`, available subcommands are :
  - \`create <name> // <description> // <type> (SW, DE, SE or RR) // <format> // <date> (optional, format: YYYY-MM-DD at HH:MM) \` : to create a tournament (**admin only**)
  - \`start\` : to start a tournament (**admin only, with PENDING tournaments, in dedicated channel**)
  - \`finalize\` : to finish a tournament (**admin only, with IN PROGRESS tournaments, in dedicated channel**)
  - \`list <filter> (optional, values: pending, underway, complete)\` : to list tournaments
  - \`join <description> (optional) [... decklist... ]\` : join a tournament (only available with PENDING tournaments, **in dedicated channel**)
  - \`status <round> (optional) \` : to get tournament current status and results (only with IN PROGRESS tournaments, **in dedicated channel**)
  - \`decks\` : to list all decks associated with this tournament (**in dedicated channel**)
  - \`report <identifier> // <winner> // <score> \` : to report a tournament match result (only available with IN PROGRESS tournaments, **in dedicated channel**)`;

  if (cmd.args.includes("create")) {
    return generateSubcommandExample(cmd, "tnmt", "create", createExample);
  } else if (cmd.args.includes("list")) {
    return generateSubcommandExample(cmd, "tnmt", "list", listExample);
  } else if (cmd.args.includes("join")) {
    return generateSubcommandExample(cmd, "tnmt", "join", joinExample);
  } else if (cmd.args.includes("status")) {
    return generateSubcommandExample(cmd, "tnmt", "status", statusExample);
  } else if (cmd.args.includes("report")) {
    return generateSubcommandExample(cmd, "tnmt", "report", reportExample);
  } else if (cmd.args.includes("start")) {
    return generateSubcommandExample(cmd, "tnmt", "start", "");
  } else if (cmd.args.includes("finalize")) {
    return generateSubcommandExample(cmd, "tnmt", "finalize", "");
  } else if (cmd.args.includes("decks")) {
    return generateSubcommandExample(cmd, "tnmt", "decks", "");
  }

  return message;
}

// handleTnmt is triggered when a user asks for a tnmt command
export async function handleTnmt(cmd: Command, origin: Message, config: any) {
  if (
    config.settings.challonge == undefined ||
    config.settings.challonge.key == undefined
  ) {
    throw new TnmtError(
      "Challonge is not properly configured on this bot instance"
    );
  }

  const chlg = new Challonge(config.settings.challonge.key);

  switch (cmd.sub) {
    case "create":
      await handleCreate(
        cmd,
        origin,
        chlg,
        config.settings.challonge,
        config.settings.challonge.parent
      );
      break;
    case "list":
      await handleList(cmd, origin, chlg);
      break;
    case "join":
      await handleJoin(
        cmd,
        origin,
        chlg,
        config.settings.challonge,
        config.settings.builder
      );
      break;
    case "status":
      await handleStatus(cmd, origin, chlg, config.settings.challonge);
      break;
    case "report":
      await handleReport(cmd, origin, chlg, config.settings.challonge);
      break;
    case "start":
      await handleStart(origin, chlg, config.settings.challonge);
      break;
    case "finalize":
      await handleFinalize(origin, chlg, config.settings.challonge);
      break;
    case "decks":
      await handleDecks(cmd, origin, config.settings.builder);
      break;
    default:
      throw new TnmtError(
        `\`${cmd.sub}\` is not a valid subcommand of the \`tnmt\` command (if you need help try \`${cmd.prefix}help\`)`
      );
  }
}

// tnmtIdFromChannel is used to ensure origin channel is a tournament one
function tnmtIDFromChannel(origin: Message): string {
  // get Discord channel object
  let ch = origin.guild.channels.cache.find(
    (ch) => ch.id === origin.channel.id
  );
  // get parts
  const parts = ch.name.split("-");
  // checks
  // length
  if (parts.length <= 2) {
    // reeturn early if not a tournament channel
    origin.channel.send("This is not a tournament channel");
    return;
  }

  // if first part is `tnmt`
  if (parts[0] != "tnmt") {
    // fail early if not a tournament channel
    origin.channel.send("This is not a tournament channel");
    return;
  }

  // second part is channel id
  return parts[1];
}

// tnmtFromChannel is used to create and return a tournament object generated from channel name
async function tnmtFromChannel(
  origin: Message,
  client: Challonge,
  config: any,
  state: TournamentInterfaces.tournamentStateEnum
): Promise<Tournament> {
  // check if channel if channel if valid
  const id = tnmtIDFromChannel(origin);

  // find all requested tournament (should be in pending mode)
  const filter = await findTournament(id, client, state);

  // create object to interact with it
  return new Tournament(config.key, filter["tournament"]);
}

// handleStart handle the start tournament subcommand
async function handleStart(origin: Message, client: Challonge, config: any) {
  // check is user requesting command have required permissions
  if (!hasPermission(origin.member.roles.cache, config.roles)) {
    origin.channel.send(
      `You don't have the required permissions to use this command`
    );
    return;
  }

  // get tournament object or die trying
  let tnmt = await tnmtFromChannel(
    origin,
    client,
    config,
    TournamentInterfaces.tournamentStateEnum.PENDING
  );

  // ensure a random roll of match ups
  await tnmt.randomizeParticipants();

  origin.channel.send(`Random rolling tournament **${tnmt["name"]}**`);

  // start tournament
  await tnmt.startTournament();

  origin.channel.send(`Tournament **${tnmt["name"]}** started ! 🃏 GLHF 🃏 !`);
}

// handleDecks is used to list all deck associated with this tournament
async function handleDecks(cmd: Command, origin: Message, builder: any) {
  // get tournament id from current channel
  const id = tnmtIDFromChannel(origin);

  // get args
  const args = parseArgs(cmd.args, true);

  // if ManaStack is used
  if (builder.kind && builder.kind == "manastack") {
    let ms = new Manastack(
      builder.username,
      builder.password,
      builder.url,
      builder.profile
    );

    // get decks and search using tournament id
    let results = await ms.formatSearch(`[Tournament: ${id}`);

    // if no result
    if (results.length == 0) {
      origin.channel.send(`No decks found for this tournament`);
    } else {
      // if a keyword is passed as argument
      if (args.length > 0) {
        // filter using this keyword
        results = results.filter((r) => {
          return r.toLowerCase().includes(args[0]);
        });
      }

      if (results.length == 0) {
        origin.channel.send(
          `No decks containing **${args[0]}** found for this tournament`
        );
        return;
      }

      // join message
      const message = results.join(`\n`);

      // check message length
      if (message.length > 2000) {
        throw new SearchResultTooLong(
          "List is too long for Discord, please provide some keywords to filter list results"
        );
      }

      // send message if everything is ok
      origin.channel.send(message);
    }
  }
}

// handleFinalize is used to finish and close a tournament
async function handleFinalize(origin: Message, client: Challonge, config: any) {
  // check is user requesting command have required permissions
  if (!hasPermission(origin.member.roles.cache, config.roles)) {
    origin.channel.send(
      `You don't have the required permissions to use this command`
    );
    return;
  }

  // get tournament
  let tnmt = await tnmtFromChannel(
    origin,
    client,
    config,
    TournamentInterfaces.tournamentStateEnum.IN_PROGRESS
  );

  // try closing, if it fails, it may be not finish yet
  try {
    await tnmt.finalizeResults();
  } catch (error) {
    // return a clearer error message
    console.error(error);
    throw new TnmtError(
      `It's impossible to finalize a tournament containing pending matches`
    );
  }

  origin.channel.send(
    `Tournament **${tnmt["name"]}** is now finalized ! Thanks everyone ! Standings are available at ${tnmt["full_challonge_url"]}/standings`
  );
}

// handleReport is used to report a match result of a specified challonge tournament
async function handleReport(
  cmd: Command,
  origin: Message,
  client: Challonge,
  config: any
) {
  // check arguments
  const args = parseArgs(cmd.args);

  // check is number of arguments is ok (fail early)
  if (args.length < Arguments["handleReport"]) {
    origin.channel.send(
      generateArgsErrorMsg(Arguments["handleReport"], cmd.prefix)
    );
    return;
  }

  // get tournament
  let tnmt = await tnmtFromChannel(
    origin,
    client,
    config,
    TournamentInterfaces.tournamentStateEnum.IN_PROGRESS
  );

  // get all matches attached to that tournament
  let matches = await tnmt.getMatches();

  const identifier = args[0].toUpperCase();

  // find requested match
  let match = matches.find((m) => {
    return m["identifier"] == identifier;
  });

  // If match is not found
  if (match == undefined) {
    throw new TnmtError(
      `Match with identifer _${identifier}_ in tournament **${tnmt["name"]}** not found`
    );
  }

  // get winner username from mention
  const username = getUserFromMention(origin.client, args[1], origin.guild);

  // get all participants
  let participants = await tnmt.getParticipants();

  // find player 1
  const p1 = participants.find((p) => {
    return p["id"] === match["player1_id"];
  });
  // ensure find is ok
  if (p1 == undefined) {
    throw new TnmtError(`Player with id ${match["player1_id"]} not found`);
  }

  // find player 2
  const p2 = participants.find((p) => {
    return p["id"] === match["player2_id"];
  });
  // ensure find is ok
  if (p2 == undefined) {
    throw new TnmtError(`Player with id ${match["player2_id"]} not found`);
  }

  // find winner in participants array
  let winner = participants.find((p) => {
    return p["display_name"] == username;
  });
  // if winner not found, trigger an error
  if (winner == undefined) {
    throw new TnmtError(
      `Participant named _${args[1]}_ not found in tournament **${tnmt["name"]}**`
    );
  }

  let score =
    winner["id"] == p1["id"] ? forgeScore(args[2], 1) : forgeScore(args[2], 2);

  match.selectWinner(winner["id"], score);

  origin.channel.send(
    `Participant **${winner["display_name"]}** has been set as winner of match **${args[0]}** in tournament **${tnmt["name"]}** _(score : ${p1["display_name"]} ${score} ${p2["display_name"]})_`
  );
}

// forgeScoreCSV is used to ensure score is in the order requested by challonge
export function forgeScore(score: string, winner: number) {
  // sanitize output by removing useless spaces
  const sanitize = score.replace(" ", "");
  // init regex
  const reg = new RegExp("(\\d+)-(\\d+)");

  // exec regex
  const res = reg.exec(sanitize);

  // ensure result is valid
  if (res == null || res.length < 3) {
    throw new TnmtError(
      "Score is not expressed correctly, please verify and try again"
    );
  }

  // check if score is valid
  if (res[1] == res[2]) {
    throw new TnmtError(
      "This is not a valid score, please verify and try again"
    );
  }

  // check if we have to invert score
  var inverse = false;

  if (winner == 1) {
    inverse = res[1] > res[2] ? false : true;
  } else {
    inverse = res[1] < res[2] ? false : true;
  }

  if (inverse) {
    return `${res[2]}-${res[1]}`;
  }

  return `${res[1]}-${res[2]}`;
}

// getUserFromMention is used to get user from a Discord @
// yes, this is a copy/paste from documentation
function getUserFromMention(client: Client, mention: string, guild: Guild) {
  // The id is the first and only match found by the RegEx.
  const matches = mention.match(/^<@!?(\d+)>$/);

  // If supplied variable was not a mention, matches will be null instead of an array.
  // return non mentionned username
  if (!matches) return mention;

  // However the first element in the matches array will be the entire mention, not just the ID,
  // so use index 1.
  const id = matches[1];

  let member = guild.members.cache.get(id);
  if (member.displayName == undefined) {
    return member.user.username;
  } else {
    return member.displayName;
  }
}

// handleStatus is used to get current status of specified challonge tournament
async function handleStatus(
  cmd: Command,
  origin: Message,
  client: Challonge,
  config: any
) {
  // response message
  let resp = "";

  // parse args
  const args = parseArgs(cmd.args);

  // get current tournament using channel title
  let tnmt = await tnmtFromChannel(
    origin,
    client,
    config,
    TournamentInterfaces.tournamentStateEnum.IN_PROGRESS
  );

  // get all parcitipants for this tournament
  let participants = await tnmt.getParticipants();

  // since matches only contains id, ensure ability to quickly found participant from his ID
  let idToParticipant = new Map();
  participants.forEach((p) => {
    idToParticipant.set(p["id"], p);
  });

  // get all the matches
  let matches = await tnmt.getMatches();

  // if an arg containing round paramater is found
  if (args[0]) {
    // filter matches if requested
    let matchesFilter = matches.filter((e) => {
      return e["round"] == args[0];
    });
    // if a filter is provided, replace matches by filtered matches
    if (matchesFilter && matchesFilter.length >= 1) {
      origin.channel.send(
        `_Here is all the matches associated with round : ${args[0]}_`
      );
      matches = matchesFilter;
    } else {
      // if filter filters nothing, fallback to all
      origin.channel.send(
        `_Nothing found using filter **${args[1]}**, fallback to no filter mode_`
      );
    }
  }

  // init round
  let round = 1;

  // for all matches, create response
  matches.forEach((m) => {
    let p1 = idToParticipant.get(m["player1_id"]);
    let p2 = idToParticipant.get(m["player2_id"]);

    // if it's a new round, add a cariage return
    if (round != m["round"]) {
      resp += "\n";
      round = m["round"];
    }

    if (m["completed_at"] == null) {
      // participants data, player 1 and player 2
      if (m["player1_id"] != null && m["player2_id"] != null) {
        resp += `_Round ${m["round"]}_ - **${p1["display_name"]} VS ${p2["display_name"]}** - state : ${m["state"]} - identifier : ${m["identifier"]}`;
      }
    } else {
      // participants data, winner and loser
      resp += `_Round ${m["round"]}_ - **${p1["display_name"]} VS ${p2["display_name"]}** - score : **${m["scores_csv"]}** - state : ${m["state"]} - identifier : ${m["identifier"]}`;
    }
    resp += "\n";
  });

  // send back response to channel
  origin.channel.send(resp);
}

// handleJoin is used to register a user to a specified challonge tournament
async function handleJoin(
  cmd: Command,
  origin: Message,
  client: Challonge,
  config: any,
  builder: any
) {
  // parse args
  const args = parseArgs(cmd.args);

  let tnmt = await tnmtFromChannel(
    origin,
    client,
    config,
    TournamentInterfaces.tournamentStateEnum.PENDING
  ).catch(async (error) => {
    // log the error, do not shadow it
    console.error(error);
    // Overwrite the error with a more end-user explicit one
    throw new TnmtError(
      `Sorry <@${origin.author.id}> but registrations for this tournament are closed (it's an __on going__ or __closed/deleted__ tournament)`
    );
  });

  // init display name
  const member = origin.guild.members.cache.get(origin.author.id);
  // fallback to username if no displayName
  var displayName =
    member.displayName == undefined
      ? origin.author.username
      : member.displayName;

  // get all participants
  const participants = await tnmt.getParticipants();

  // if participant already register, throw error
  participants.forEach((p) => {
    if (p["display_name"] == displayName) {
      origin.channel.send(
        `Participant <@${origin.author.id}> is already registered in tournament ${tnmt["name"]}`
      );
      return;
    }
  });

  origin.channel.send(`_Processing ${displayName} decklist_`);

  // create deck
  let meta = new Array();
  // prepare meta data
  // name
  let title = `[Tournament: ${tnmtIDFromChannel(
    origin
  )}] ${displayName}'s Deck`;
  args.length >= 1 ? (title += ` (${args[0]})`) : title;
  meta.push(title);
  // Format, TODO more specific if format is supported by builder, use casual as default
  meta.push(`casual`);
  // description
  meta.push(
    `Deck played by participant ${displayName} during tournament ${tnmt["name"]}`
  );
  let deck = new Deck(meta);

  // Build it
  // try from attachment
  const fromAttachment = await decklistFromAttachment(origin);
  if (fromAttachment != null) {
    await deck.buildDeck(fromAttachment, true);
  } // if not found, fallback to text message
  else {
    await deck.buildDeck(cmd.extra, true);
  }

  // sync deck to Manastack
  if (builder.kind && builder.kind == "manastack") {
    var ms = new Manastack(
      builder.username,
      builder.password,
      builder.url,
      builder.profile
    );

    // Try formating the deck to ManaStack format
    let formated = deck.exportToManaStack();

    // Try creating the deck on ManaStack
    var synced = await ms.newDeck(
      deck.metadata.name,
      deck.metadata.description,
      // FIXME: quick fix to enable transition to interface
      9,
      formated
    );
  }

  // add participant to associated tournament
  await tnmt
    .newParticipant({ name: displayName, misc: synced.getUrl() })
    .catch(async (error) => {
      // ensure a deck delete since adding a participant trigger an error
      if (builder.kind && builder.kind == "manastack") {
        await ms.deleteDeck(synced.getID());
      }

      // continue and throw error
      throw error;
    });

  // return decklist, and message
  origin.channel.send(
    `Registration successfull for user <@${origin.author.id}> in tournament ${
      tnmt["full_challonge_url"]
    }, deck list is available at ${synced.getUrl()}`
  );
}

// handleList is used to list all tournaments on challonge
async function handleList(cmd: Command, origin: Message, client: Challonge) {
  // set a limit
  const limit = 10;

  // declare optionnal parameters
  let params = {};

  // fill optional parameters
  if (cmd.args.toLocaleLowerCase().includes("pending")) {
    params = { state: TournamentInterfaces.tournamentStateEnum.PENDING };
  } else if (cmd.args.toLocaleLowerCase().includes("complete")) {
    params = { state: TournamentInterfaces.tournamentStateEnum.ENDED };
  } else if (cmd.args.toLocaleLowerCase().includes("underway")) {
    params = { state: TournamentInterfaces.tournamentStateEnum.IN_PROGRESS };
  }

  // get all tournaments
  let all = await client.getTournaments(params);

  // challonge-ts sort by id, so reverse to get most recent entries
  all = all.reverse();

  // prepare output
  let parts: string[] = [];

  // check len, set limit if needed
  let len = all.length < limit ? all.length : limit;

  // loop over items (limit or length) and generate line
  for (let index = 0; index < len; index++) {
    parts.push(generateListLine(all[index]));
  }

  // check if something was found
  if (parts.length == 0) {
    origin.channel.send(`Sorry, there is no entry matching the request`);
  } else {
    // push message to channel by joining outputs parts
    origin.channel.send(parts.join("\n"));
  }
}

// generateListLine is used to generate an output line for each tournament
function generateListLine(t: Tournament) {
  // base of the string
  let base = `**${t["data"]["tournament"]["name"]}** - Code : _${getCode(
    t["data"]["tournament"]["full_challonge_url"]
  )}_ - ${t["data"]["tournament"]["full_challonge_url"]}`;

  // date
  let date = "";

  // date is specific for each tournament state
  switch (t["data"]["tournament"]["state"]) {
    case "complete":
      var started = new Date(t["data"]["tournament"]["started_at"]);
      var completed = new Date(t["data"]["tournament"]["completed_at"]);
      date = `started at **${started.toDateString()}** and completed at **${completed.toDateString()}**`;
      break;
    case "underway":
      var started = new Date(t["data"]["tournament"]["started_at"]);
      date = `started at **${started.toDateString()}**`;
      break;
    case "pending":
      var start = new Date(t["data"]["tournament"]["start_at"]);
      date = `starting at **${start.toDateString()}** | **${start.toTimeString()}**`;
      break;
    default:
      var started = new Date(t["data"]["tournament"]["created_at"]);
      date = `created at **${started.toDateString()}**`;
      break;
  }

  // return full string
  return base + " - " + t["data"]["tournament"]["state"] + " - " + date;
}

// handleCreate is used to create a tournament on challonge
async function handleCreate(
  cmd: Command,
  origin: Message,
  client: Challonge,
  config: any,
  parent: string
) {
  // check authorization and permissions, fail early
  if (!isAuthorized(origin.channel.id, config.channels)) {
    origin.channel.send(`This command cannot be used on this channel`);
    return;
  }

  if (!hasPermission(origin.member.roles.cache, config.roles)) {
    origin.channel.send(
      `You don't have the required permissions to use this command`
    );
    return;
  }

  // parse args
  const args = parseArgs(cmd.args, true);
  // ensure args requirements
  if (args.length < Arguments["handleCreate"]) {
    origin.channel.send(
      generateArgsErrorMsg(Arguments["handleCreate"], cmd.prefix)
    );
    return;
  }

  // if everything is ok, create
  await create(args, origin, client, parent);
}

// parseTnmtType is used to translate a tournament type as a string to a Challonge supported type
function parseTnmtType(input: string): TournamentInterfaces.tournamentTypeEnum {
  // return specific value for each possible tournament
  switch (input.toLocaleUpperCase()) {
    case "SW":
      return TournamentInterfaces.tournamentTypeEnum.SWISS;
    case "DE":
      return TournamentInterfaces.tournamentTypeEnum.DOUBLE_ELIMINATION;
    case "SE":
      return TournamentInterfaces.tournamentTypeEnum.SINGLE_ELIMINATION;
    case "RR":
      return TournamentInterfaces.tournamentTypeEnum.ROUND_ROBIN;
    default:
      throw new TnmtError(
        `Tournament type ${input} is not supported by Challonge`
      );
  }
}

// parseDate is used to parse date from a Discord argument
function parseDate(input: string): Date | null {
  // parse input
  const regex = new RegExp(/(\d{4})-(\d{2})-(\d{2}) at (\d{2}):(\d{2})/);
  // exec regex
  let res = regex.exec(input);

  // check match results
  if (!res || res.length < 6) {
    return null;
  }

  // if it's ok, convert to int
  let toInt: number[] = res.map((e) => {
    return Number.parseInt(e);
  });

  // create date
  return new Date(toInt[1], toInt[2], toInt[3], toInt[4], toInt[5]);
}

// createTnmtChannel is used to ensure a dedicated channel per tournament
async function createTnmtChannel(
  origin: Message,
  name: string,
  code: string,
  category: string
) {
  let channel = await origin.guild.channels
    .create(`tnmt-${code}-${name}`, {
      type: "text",
    })
    .then((ch) => ch.setParent(category));

  return channel;
}

// create is used to trigger a tournament creation on challonge
async function create(
  args: string[],
  origin: Message,
  client: Challonge,
  category: string
) {
  // generate pseudo-random code from name
  const code = generateCode(args[0]);

  // generate name by adding format in it
  const name = generateName(args[0], args[3]);

  // Here is a generic overview of arguments order
  // NAME // DESCRIPTION // TYPE // FORMAT // DATE
  let meta = {
    accept_attachments: true,
    description: args[1],
    tournament_type: parseTnmtType(args[2]),
    name: name,
    url: code,
  };

  // if a date is specified
  if (args[4]) {
    // parse it
    let date = parseDate(args[4]);
    // if parsing fail
    if (date == null) {
      // default to now
      origin.channel.send(
        `Warning, date used is not in a valid format and will not be used`
      );
    } else {
      // add date information by merging the two objects
      meta = { ...meta, ...{ start_at: date } };
    }
  }

  // trigger call to challonge API
  const tnmt = await client.createTournament(meta);

  // create specific tournament channel
  let channel = await createTnmtChannel(origin, args[0], code, category);

  // send message to channel when tournament is created
  origin.channel.send(
    `Tournament **${args[0]}** created and available at ${tnmt["full_challonge_url"]}, you can now use the dedicated channel <#${channel.id}>, to interact with it`
  );
}

// generateCode is used to generate a pseudo code for the current tournament
function generateCode(name: string) {
  return MD5(name).toString().slice(0, 5);
}

// getCode is used to retreive code from a tournament url
function getCode(url: string): string {
  // split on / and get the last part of the url
  return url.split("/").reverse()[0];
}

// generateName si used to generated final name of tournament on Challonge using name and specified format
function generateName(name: string, format: string): string {
  return `[Format: ${format.toLocaleUpperCase()}] ${name}`;
}

// findTournament is used to find the first tournament matching id parameter
async function findTournament(
  id: string,
  client: Challonge,
  status: TournamentInterfaces.tournamentStateEnum
) {
  // get pending tournaments
  let tnmts = await client.getTournaments({ state: status });
  // filter using specified ID by the participant
  let found = tnmts.find((t) => {
    return getCode(t["data"]["tournament"]["full_challonge_url"]) == id;
  });

  // check if tournament exists and is in pending state
  if (found == undefined) {
    throw new TnmtError(
      `There is no tournament with status '${status.replace(
        "_",
        " "
      )}' associated with id '${id}'.`
    );
  }

  return found;
}

// Arity arguments mapper
let Arguments: { [f: string]: number } = {
  handleCreate: 4,
  handleReport: 3,
};

// Sync Command Error
export class TnmtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Tournament Error";
    this.message = message;
  }
}

// Examples
// create subcommand example
let createExample = `Tournament Name // Tournament Description // SW // Forgeron // 2020-11-07 at 17:00`;

// list subcommand example
let listExample = `pending`;

// join subcommand example
let joinExample = `Awesome deck
Deck
4 Frisson de probabilité (ELD) 146
4 Soif de sens (THB) 74
4 Montagne (THB) 285
2 Falaises des eaux vives (M20) 252
2 Électromancien gobelin (GRN) 174
1 Étreinte de lave (GRN) 108
3 Frappe foudroyante (XLN) 149
4 Landes de cendres (M19) 248
4 Révélation // Répartition (GRN) 223
4 Marais (THB) 283
3 Érudite des âges (M20) 74
2 Géant rugissant (M20) 177
2 Île (THB) 281
1 Golem météoritique (M19) 241
3 Don du chaudron (ELD) 83
4 Étendues sauvages en évolution (RIX) 186
2 Du sang pour les os (M20) 89
3 Liche engrimoirée (M20) 219
1 Marigot lugubre (M20) 245
3 Ossuaire submergé (M19) 257
4 Tritonne des fondrières (THB) 105

Réserve
3 Instant d'envie (RIX) 79
2 Contrainte (M19) 94
1 Étanchement (RNA) 48
2 Cramer (M20) 140
2 Pyrohélice de Chandra (WAR) 120
3 Balayage de flammes (M20) 139
2 Surgissement de Ral (WAR) 212`;

// status subcommand example
let statusExample = `1`;

// report subcommand example
let reportExample = `A // @Mayalabielle // 2-1`;
