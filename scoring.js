const crypto = require('crypto');

const MATCH_STATUSES = ['scheduled', 'live', 'awaiting_awards', 'completed'];
const INNINGS_STATUSES = ['ready', 'live', 'completed'];
const DISMISSAL_KINDS = new Set([
  'bowled',
  'caught',
  'lbw',
  'stumped',
  'hit-wicket',
  'run-out',
  'retired-hurt',
  'retired-out',
  'obstructing-field',
  'hit-ball-twice',
  'timed-out'
]);
const BOWLER_WICKET_KINDS = new Set(['bowled', 'caught', 'lbw', 'stumped', 'hit-wicket']);
const NO_BALL_WICKET_KINDS = new Set(['run-out', 'obstructing-field', 'hit-ball-twice']);
const WIDE_WICKET_KINDS = new Set(['run-out', 'stumped', 'hit-wicket', 'obstructing-field']);

class ScoringError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.name = 'ScoringError';
    this.status = status;
    this.details = details;
  }
}

function idOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    if (typeof value.toHexString === 'function') return value.toHexString();
    if (value._id && value._id !== value) return idOf(value._id);
  }
  return String(value);
}

function sameId(left, right) {
  return Boolean(idOf(left)) && idOf(left) === idOf(right);
}

function plain(value) {
  if (!value) return value;
  if (typeof value.toObject === 'function') {
    const object = value.toObject();
    if (value.$locals?.scoringTeams) object._resolvedTeams = value.$locals.scoringTeams;
    return object;
  }
  return value;
}

function nonNegativeInteger(value, label, fallback = 0) {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new ScoringError(`${label} must be a non-negative whole number`);
  }
  return candidate;
}

function positiveInteger(value, label, fallback) {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new ScoringError(`${label} must be a positive whole number`);
  }
  return candidate;
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function oversFromBalls(legalBalls) {
  const balls = Math.max(0, Number(legalBalls || 0));
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

function normalizeDismissalKind(value) {
  const normalized = String(value || 'run-out')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const aliases = {
    'obstructing-the-field': 'obstructing-field',
    'hit-the-ball-twice': 'hit-ball-twice'
  };
  return aliases[normalized] || normalized;
}

function normalizeDeliveryInput(input = {}) {
  const runsOffBat = nonNegativeInteger(input.runsOffBat ?? input.runs, 'Runs off the bat');
  const rawExtras = input.extras || {};
  const extras = {
    wide: nonNegativeInteger(rawExtras.wide ?? rawExtras.wides, 'Wide runs'),
    noBall: nonNegativeInteger(rawExtras.noBall ?? rawExtras.noBalls ?? rawExtras.noball, 'No-ball runs'),
    bye: nonNegativeInteger(rawExtras.bye ?? rawExtras.byes, 'Bye runs'),
    legBye: nonNegativeInteger(rawExtras.legBye ?? rawExtras.legByes ?? rawExtras.legbye, 'Leg-bye runs'),
    penalty: nonNegativeInteger(rawExtras.penalty, 'Penalty runs')
  };

  if (extras.wide && extras.noBall) {
    throw new ScoringError('A delivery cannot be both a wide and a no-ball');
  }
  if (extras.bye && extras.legBye) {
    throw new ScoringError('A delivery cannot contain both byes and leg-byes');
  }
  if (extras.wide && (runsOffBat || extras.bye || extras.legBye)) {
    throw new ScoringError('Runs off the bat, byes, and leg-byes cannot be scored on a wide');
  }
  if (runsOffBat && (extras.bye || extras.legBye)) {
    throw new ScoringError('Runs off the bat cannot be combined with byes or leg-byes');
  }

  const totalRuns = runsOffBat
    + extras.wide
    + extras.noBall
    + extras.bye
    + extras.legBye
    + extras.penalty;
  const inferredRunningRuns = extras.wide
    ? Math.max(0, extras.wide - 1)
    : extras.bye || extras.legBye || runsOffBat;
  const runningRuns = nonNegativeInteger(input.runningRuns, 'Completed running runs', inferredRunningRuns);
  if (runningRuns > totalRuns) {
    throw new ScoringError('Completed running runs cannot exceed the delivery total');
  }

  const rawWicket = input.wicket || (input.isWicket ? {
    kind: input.wicketKind,
    dismissedBatterId: input.dismissedBatterId,
    creditedToBowler: input.creditedToBowler
  } : null);
  let wicket = null;

  if (rawWicket && rawWicket.isWicket !== false) {
    const kind = normalizeDismissalKind(rawWicket.kind);
    if (!DISMISSAL_KINDS.has(kind)) {
      throw new ScoringError(`Unsupported dismissal type: ${kind}`);
    }
    if (extras.noBall && !NO_BALL_WICKET_KINDS.has(kind)) {
      throw new ScoringError(`${kind} is not a valid dismissal from a no-ball`);
    }
    if (extras.wide && !WIDE_WICKET_KINDS.has(kind)) {
      throw new ScoringError(`${kind} is not a valid dismissal from a wide`);
    }

    wicket = {
      isWicket: true,
      kind,
      dismissedBatterId: rawWicket.dismissedBatterId || rawWicket.playerId || null,
      dismissedBatterName: rawWicket.dismissedBatterName || rawWicket.playerName || '',
      countsAsWicket: kind !== 'retired-hurt',
      creditedToBowler: BOWLER_WICKET_KINDS.has(kind)
    };
  }

  return {
    clientRequestId: String(input.clientRequestId || '').trim(),
    sequence: input.sequence === undefined ? undefined : nonNegativeInteger(input.sequence, 'Delivery sequence'),
    runsOffBat,
    extras,
    runningRuns,
    totalRuns,
    isLegal: !extras.wide && !extras.noBall,
    wicket,
    note: String(input.note || '').trim().slice(0, 500)
  };
}

function getTeamSnapshots(match) {
  const resolvedTeams = plain(match._resolvedTeams || match.$locals?.scoringTeams);
  if (Array.isArray(resolvedTeams) && resolvedTeams.length) {
    return resolvedTeams.map(plain).filter(Boolean);
  }
  return [plain(match.teamA), plain(match.teamB)].filter(Boolean);
}

function matchTeamId(match, side) {
  const legacyTeam = plain(match?.[side]);
  return match?.[`${side}Id`] || legacyTeam?.teamId || legacyTeam?._id || null;
}

function attachResolvedTeams(match, teams) {
  if (!match) return match;
  if (typeof match.toObject === 'function') {
    match.$locals.scoringTeams = teams;
  } else {
    match._resolvedTeams = teams;
  }
  return match;
}

function getTeamSnapshot(match, teamId) {
  return getTeamSnapshots(match).find((team) => sameId(team.teamId, teamId)) || null;
}

function getPlayerSnapshot(match, playerId) {
  const wantedId = idOf(playerId);
  if (!wantedId) return null;
  for (const team of getTeamSnapshots(match)) {
    const player = (team.players || []).find((entry) => sameId(entry.playerId, wantedId));
    if (player) {
      return {
        ...plain(player),
        teamId: team.teamId,
        teamName: team.name,
        teamLogo: team.logo || ''
      };
    }
  }
  return null;
}

function playerName(match, playerId, fallback = '') {
  return getPlayerSnapshot(match, playerId)?.name || fallback || '';
}

function inningsPlayerIds(match, innings, batting = true) {
  const team = getTeamSnapshot(match, batting ? innings.battingTeamId : innings.bowlingTeamId);
  return new Set((team?.players || []).map((player) => idOf(player.playerId)));
}

function applyLineupEvents(state, lineupEvents, afterSequence) {
  const next = { ...state };
  (lineupEvents || []).forEach((event) => {
    if (Number(event.afterSequence || 0) !== Number(afterSequence || 0)) return;
    if (event.strikerId !== undefined) next.strikerId = event.strikerId || null;
    if (event.nonStrikerId !== undefined) next.nonStrikerId = event.nonStrikerId || null;
    if (event.bowlerId !== undefined) next.bowlerId = event.bowlerId || null;
  });
  return next;
}

function swapBatters(state) {
  return {
    ...state,
    strikerId: state.nonStrikerId || null,
    nonStrikerId: state.strikerId || null
  };
}

function computePostDeliveryState(stateBefore, delivery, legalBallsBefore) {
  let next = { ...stateBefore };
  if (delivery.runningRuns % 2 === 1) next = swapBatters(next);

  if (delivery.wicket) {
    const dismissedId = delivery.wicket.dismissedBatterId;
    if (sameId(next.strikerId, dismissedId)) next.strikerId = null;
    if (sameId(next.nonStrikerId, dismissedId)) next.nonStrikerId = null;
  }

  const legalBallsAfter = legalBallsBefore + (delivery.isLegal ? 1 : 0);
  const overCompleted = delivery.isLegal && legalBallsAfter % 6 === 0;
  if (overCompleted) {
    next = swapBatters(next);
    next.bowlerId = null;
  }

  return {
    ...next,
    legalBalls: legalBallsAfter,
    overCompleted
  };
}

function resolveMaxWickets(match, innings) {
  const squadSize = getTeamSnapshot(match, innings.battingTeamId)?.players?.length || 0;
  const squadLimit = Math.max(1, squadSize - 1);
  return Math.max(1, Math.min(Number(match.maxWickets || 10), squadLimit));
}

function replayInnings(matchInput, inningsInput, context = {}) {
  const match = plain(matchInput);
  const innings = plain(inningsInput);
  const rawDeliveries = (innings.deliveries || []).map(plain);
  const lineupEvents = (innings.lineupEvents || []).map(plain);
  const battingIds = inningsPlayerIds(match, innings, true);
  const bowlingIds = inningsPlayerIds(match, innings, false);
  const maxLegalBalls = Number(match.oversPerInnings || 0) * 6;
  const maxWickets = resolveMaxWickets(match, innings);
  const target = context.target ? Number(context.target) : null;
  const strict = context.strict !== false;
  const errors = [];
  const dismissedIds = new Set();
  const canonicalDeliveries = [];
  let state = {
    strikerId: null,
    nonStrikerId: null,
    bowlerId: null,
    legalBalls: 0,
    totalRuns: 0,
    wickets: 0,
    overCompleted: false
  };
  let lastSequence = 0;
  let terminalReason = '';

  const fail = (message) => {
    if (strict) throw new ScoringError(message);
    errors.push(message);
  };

  rawDeliveries.forEach((stored, index) => {
    if (terminalReason) {
      fail(`Delivery ${index + 1} appears after the innings had already ended`);
      return;
    }

    state = applyLineupEvents(state, lineupEvents, lastSequence);
    if (!state.strikerId || !state.nonStrikerId || !state.bowlerId) {
      fail(`Lineup is incomplete before delivery ${index + 1}`);
    }
    if (state.strikerId && !battingIds.has(idOf(state.strikerId))) {
      fail(`Invalid striker before delivery ${index + 1}`);
    }
    if (state.nonStrikerId && !battingIds.has(idOf(state.nonStrikerId))) {
      fail(`Invalid non-striker before delivery ${index + 1}`);
    }
    if (state.bowlerId && !bowlingIds.has(idOf(state.bowlerId))) {
      fail(`Invalid bowler before delivery ${index + 1}`);
    }
    if (sameId(state.strikerId, state.nonStrikerId)) {
      fail(`Striker and non-striker are the same before delivery ${index + 1}`);
    }

    const normalized = normalizeDeliveryInput(stored);
    const sequence = Number(stored.sequence || normalized.sequence || index + 1);
    const wicket = normalized.wicket ? { ...normalized.wicket } : null;
    if (wicket) {
      wicket.dismissedBatterId = wicket.dismissedBatterId || state.strikerId;
      if (!sameId(wicket.dismissedBatterId, state.strikerId)
        && !sameId(wicket.dismissedBatterId, state.nonStrikerId)) {
        fail(`Dismissed player was not at the crease on delivery ${sequence}`);
      }
      if (dismissedIds.has(idOf(wicket.dismissedBatterId))) {
        fail(`Player was already dismissed before delivery ${sequence}`);
      }
      wicket.dismissedBatterName = playerName(
        match,
        wicket.dismissedBatterId,
        wicket.dismissedBatterName
      );
    }

    const legalBallsBefore = state.legalBalls;
    const stateBefore = { ...state };
    const canonical = {
      ...stored,
      ...normalized,
      _id: stored._id,
      sequence,
      wicket,
      strikerId: state.strikerId || null,
      strikerName: playerName(match, state.strikerId, stored.strikerName),
      nonStrikerId: state.nonStrikerId || null,
      nonStrikerName: playerName(match, state.nonStrikerId, stored.nonStrikerName),
      bowlerId: state.bowlerId || null,
      bowlerName: playerName(match, state.bowlerId, stored.bowlerName),
      legalBallsBefore,
      overNumber: Math.floor(legalBallsBefore / 6),
      ballNumber: (legalBallsBefore % 6) + 1,
      displayBall: `${Math.floor(legalBallsBefore / 6)}.${(legalBallsBefore % 6) + 1}`
    };

    const after = computePostDeliveryState(stateBefore, canonical, legalBallsBefore);
    state = {
      ...after,
      totalRuns: state.totalRuns + canonical.totalRuns,
      wickets: state.wickets + (wicket?.countsAsWicket ? 1 : 0)
    };
    if (wicket && wicket.kind !== 'retired-hurt') {
      dismissedIds.add(idOf(wicket.dismissedBatterId));
    }
    lastSequence = sequence;
    canonicalDeliveries.push(canonical);

    if (target && state.totalRuns >= target) terminalReason = 'target-reached';
    else if (state.wickets >= maxWickets) terminalReason = 'all-out';
    else if (maxLegalBalls && state.legalBalls >= maxLegalBalls) terminalReason = 'overs-complete';
  });

  if (!terminalReason) {
    state = applyLineupEvents(state, lineupEvents, lastSequence);
  }

  if (state.strikerId && dismissedIds.has(idOf(state.strikerId))) {
    fail('A dismissed player cannot remain striker');
  }
  if (state.nonStrikerId && dismissedIds.has(idOf(state.nonStrikerId))) {
    fail('A dismissed player cannot remain non-striker');
  }

  return {
    deliveries: canonicalDeliveries,
    state,
    dismissedIds,
    errors,
    lastSequence,
    terminal: Boolean(terminalReason),
    terminalReason,
    totalRuns: state.totalRuns,
    wickets: state.wickets,
    legalBalls: state.legalBalls,
    overs: oversFromBalls(state.legalBalls),
    maxLegalBalls,
    maxWickets,
    target
  };
}

function dismissalText(delivery) {
  const wicket = delivery.wicket;
  if (!wicket) return '';
  const bowlerName = delivery.bowlerName || 'bowler';
  switch (wicket.kind) {
    case 'bowled': return `b ${bowlerName}`;
    case 'caught': return `c b ${bowlerName}`;
    case 'lbw': return `lbw b ${bowlerName}`;
    case 'stumped': return `stumped b ${bowlerName}`;
    case 'hit-wicket': return `hit wicket b ${bowlerName}`;
    case 'run-out': return 'run out';
    case 'retired-hurt': return 'retired hurt';
    case 'retired-out': return 'retired out';
    case 'timed-out': return 'timed out';
    case 'obstructing-field': return 'obstructing the field';
    case 'hit-ball-twice': return 'hit the ball twice';
    default: return wicket.kind;
  }
}

function buildInningsScorecard(matchInput, inningsInput, replay) {
  const match = plain(matchInput);
  const innings = plain(inningsInput);
  const battingTeam = getTeamSnapshot(match, innings.battingTeamId);
  const bowlingTeam = getTeamSnapshot(match, innings.bowlingTeamId);
  const batting = new Map();
  const bowling = new Map();
  const extras = { wide: 0, noBall: 0, bye: 0, legBye: 0, penalty: 0, total: 0 };
  const fallOfWickets = [];
  const overBowlerStats = new Map();
  let partnershipRuns = 0;
  let partnershipBalls = 0;
  let nextAppearanceOrder = 0;

  const markBatterAppeared = (entry) => {
    if (!entry || entry.didBat) return;
    entry.didBat = true;
    entry.appearanceOrder = nextAppearanceOrder;
    nextAppearanceOrder += 1;
  };

  (battingTeam?.players || []).forEach((snapshot, order) => {
    batting.set(idOf(snapshot.playerId), {
      playerId: snapshot.playerId,
      name: snapshot.name,
      image: snapshot.image || '',
      order,
      appearanceOrder: null,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      strikeRate: 0,
      isOut: false,
      dismissal: '',
      didBat: false,
      isStriker: false,
      isNonStriker: false
    });
  });

  (bowlingTeam?.players || []).forEach((snapshot, order) => {
    bowling.set(idOf(snapshot.playerId), {
      playerId: snapshot.playerId,
      name: snapshot.name,
      image: snapshot.image || '',
      order,
      balls: 0,
      overs: '0.0',
      maidens: 0,
      runs: 0,
      wickets: 0,
      wides: 0,
      noBalls: 0,
      economy: 0,
      isCurrent: false
    });
  });

  replay.deliveries.forEach((delivery) => {
    const batter = batting.get(idOf(delivery.strikerId));
    if (batter) {
      markBatterAppeared(batter);
      batter.runs += delivery.runsOffBat;
      if (delivery.isLegal) batter.balls += 1;
      if (delivery.runsOffBat === 4) batter.fours += 1;
      if (delivery.runsOffBat === 6) batter.sixes += 1;
    }
    markBatterAppeared(batting.get(idOf(delivery.nonStrikerId)));

    const bowler = bowling.get(idOf(delivery.bowlerId));
    if (bowler) {
      if (delivery.isLegal) bowler.balls += 1;
      bowler.runs += delivery.runsOffBat + delivery.extras.wide + delivery.extras.noBall;
      bowler.wides += delivery.extras.wide;
      bowler.noBalls += delivery.extras.noBall;
      if (delivery.wicket?.creditedToBowler) bowler.wickets += 1;

      const overKey = `${idOf(delivery.bowlerId)}:${delivery.overNumber}`;
      const overStats = overBowlerStats.get(overKey) || { legalBalls: 0, chargedRuns: 0 };
      if (delivery.isLegal) overStats.legalBalls += 1;
      overStats.chargedRuns += delivery.runsOffBat + delivery.extras.wide + delivery.extras.noBall;
      overBowlerStats.set(overKey, overStats);
    }

    Object.keys(extras).forEach((key) => {
      if (key !== 'total') extras[key] += delivery.extras[key] || 0;
    });
    extras.total += Object.values(delivery.extras).reduce((sum, value) => sum + Number(value || 0), 0);

    partnershipRuns += delivery.totalRuns;
    if (delivery.isLegal) partnershipBalls += 1;

    if (delivery.wicket) {
      const dismissed = batting.get(idOf(delivery.wicket.dismissedBatterId));
      if (dismissed) {
        markBatterAppeared(dismissed);
        dismissed.isOut = Boolean(delivery.wicket.countsAsWicket);
        dismissed.dismissal = dismissalText(delivery);
      }
      if (delivery.wicket.countsAsWicket) {
        fallOfWickets.push({
          wicket: fallOfWickets.length + 1,
          score: replay.deliveries
            .slice(0, replay.deliveries.indexOf(delivery) + 1)
            .reduce((sum, item) => sum + item.totalRuns, 0),
          playerId: delivery.wicket.dismissedBatterId,
          playerName: delivery.wicket.dismissedBatterName,
          over: delivery.displayBall
        });
        partnershipRuns = 0;
        partnershipBalls = 0;
      }
    }
  });

  markBatterAppeared(batting.get(idOf(replay.state.strikerId)));
  markBatterAppeared(batting.get(idOf(replay.state.nonStrikerId)));

  overBowlerStats.forEach((stats, key) => {
    if (stats.legalBalls !== 6 || stats.chargedRuns !== 0) return;
    const bowlerId = key.split(':')[0];
    const bowler = bowling.get(bowlerId);
    if (bowler) bowler.maidens += 1;
  });

  const allBatters = [...batting.values()].map((entry) => ({
    ...entry,
    isStriker: sameId(entry.playerId, replay.state.strikerId),
    isNonStriker: sameId(entry.playerId, replay.state.nonStrikerId),
    strikeRate: entry.balls ? round((entry.runs / entry.balls) * 100) : 0
  }));
  const battingScorecard = allBatters
    .filter((entry) => entry.didBat || entry.isOut || entry.isStriker || entry.isNonStriker)
    .sort((left, right) => (
      Number(left.appearanceOrder ?? Number.MAX_SAFE_INTEGER)
      - Number(right.appearanceOrder ?? Number.MAX_SAFE_INTEGER)
      || left.order - right.order
    ));
  const didNotBat = allBatters
    .filter((entry) => !entry.didBat && !entry.isOut && !entry.isStriker && !entry.isNonStriker)
    .map(({ playerId, name, image }) => ({ playerId, name, image }));
  const bowlingScorecard = [...bowling.values()]
    .filter((entry) => entry.balls || entry.runs || entry.wickets
      || sameId(entry.playerId, replay.state.bowlerId))
    .map((entry) => ({
      ...entry,
      isCurrent: sameId(entry.playerId, replay.state.bowlerId),
      overs: oversFromBalls(entry.balls),
      economy: entry.balls ? round(entry.runs / (entry.balls / 6)) : 0
    }))
    .sort((left, right) => left.order - right.order);

  const totalRuns = replay.totalRuns;
  const currentRunRate = replay.legalBalls ? round(totalRuns / (replay.legalBalls / 6)) : 0;
  const requiredRuns = replay.target ? Math.max(0, replay.target - totalRuns) : null;
  const ballsRemaining = replay.maxLegalBalls
    ? Math.max(0, replay.maxLegalBalls - replay.legalBalls)
    : null;
  const requiredRunRate = replay.target && requiredRuns > 0 && ballsRemaining > 0
    ? round(requiredRuns / (ballsRemaining / 6))
    : null;

  return {
    number: innings.number,
    status: replay.terminal ? 'completed' : innings.status,
    battingTeam: {
      teamId: battingTeam?.teamId || innings.battingTeamId,
      name: battingTeam?.name || innings.battingTeamName || '',
      logo: battingTeam?.logo || innings.battingTeamLogo || ''
    },
    bowlingTeam: {
      teamId: bowlingTeam?.teamId || innings.bowlingTeamId,
      name: bowlingTeam?.name || innings.bowlingTeamName || '',
      logo: bowlingTeam?.logo || innings.bowlingTeamLogo || ''
    },
    totalRuns,
    wickets: replay.wickets,
    legalBalls: replay.legalBalls,
    overs: replay.overs,
    maxWickets: replay.maxWickets,
    target: replay.target,
    requiredRuns,
    ballsRemaining,
    currentRunRate,
    requiredRunRate,
    extras,
    striker: getPlayerSnapshot(match, replay.state.strikerId),
    nonStriker: getPlayerSnapshot(match, replay.state.nonStrikerId),
    currentBowler: getPlayerSnapshot(match, replay.state.bowlerId),
    strikerId: replay.state.strikerId || null,
    nonStrikerId: replay.state.nonStrikerId || null,
    bowlerId: replay.state.bowlerId || null,
    needsBatter: !replay.state.strikerId || !replay.state.nonStrikerId,
    needsBowler: !replay.state.bowlerId,
    canScore: !replay.terminal
      && Boolean(replay.state.strikerId && replay.state.nonStrikerId && replay.state.bowlerId),
    lastDelivery: replay.deliveries[replay.deliveries.length - 1] || null,
    partnership: { runs: partnershipRuns, balls: partnershipBalls },
    battingScorecard,
    didNotBat,
    bowlingScorecard,
    fallOfWickets,
    terminal: replay.terminal,
    terminalReason: replay.terminalReason,
    errors: replay.errors
  };
}

function buildResult(match, inningsViews, forceComplete = false) {
  if (inningsViews.length < 2) {
    return match.result?.text ? plain(match.result) : null;
  }

  const first = inningsViews[0];
  const second = inningsViews[1];
  const secondFinished = second.terminal || forceComplete || match.status === 'completed';
  if (second.totalRuns >= first.totalRuns + 1) {
    const wicketsRemaining = Math.max(1, second.maxWickets - second.wickets);
    return {
      winnerTeamId: second.battingTeam.teamId,
      winnerTeamName: second.battingTeam.name,
      tie: false,
      marginType: 'wickets',
      margin: wicketsRemaining,
      text: `${second.battingTeam.name} won by ${wicketsRemaining} wicket${wicketsRemaining === 1 ? '' : 's'}`
    };
  }
  if (!secondFinished) return null;
  if (second.totalRuns === first.totalRuns) {
    return {
      winnerTeamId: null,
      winnerTeamName: '',
      tie: true,
      marginType: 'tie',
      margin: 0,
      text: 'Match tied'
    };
  }
  const margin = first.totalRuns - second.totalRuns;
  return {
    winnerTeamId: first.battingTeam.teamId,
    winnerTeamName: first.battingTeam.name,
    tie: false,
    marginType: 'runs',
    margin,
    text: `${first.battingTeam.name} won by ${margin} run${margin === 1 ? '' : 's'}`
  };
}

function playerAwardSnapshot(match, playerId, stats = {}) {
  const player = getPlayerSnapshot(match, playerId);
  if (!player) return null;
  return {
    playerId: player.playerId,
    name: player.name,
    image: player.image || '',
    teamId: player.teamId,
    teamName: player.teamName,
    ...stats
  };
}

function deriveAutomaticAwards(match, inningsViews) {
  const aggregates = new Map();
  const ensure = (entry, team) => {
    const key = idOf(entry.playerId);
    const existing = aggregates.get(key) || {
      playerId: entry.playerId,
      name: entry.name,
      teamId: team.teamId,
      teamName: team.name,
      battingRuns: 0,
      wickets: 0,
      bowlingRuns: 0,
      bowlingBalls: 0
    };
    aggregates.set(key, existing);
    return existing;
  };

  inningsViews.forEach((innings) => {
    innings.battingScorecard.forEach((entry) => {
      if (!entry.didBat) return;
      ensure(entry, innings.battingTeam).battingRuns += entry.runs;
    });
    innings.bowlingScorecard.forEach((entry) => {
      const aggregate = ensure(entry, innings.bowlingTeam);
      aggregate.wickets += entry.wickets;
      aggregate.bowlingRuns += entry.runs;
      aggregate.bowlingBalls += entry.balls;
    });
  });

  const entries = [...aggregates.values()];
  const bestBowler = [...entries]
    .filter((entry) => entry.bowlingBalls || entry.wickets)
    .sort((left, right) => (
      right.wickets - left.wickets
      || left.bowlingRuns - right.bowlingRuns
      || right.bowlingBalls - left.bowlingBalls
    ))[0];
  const manOfMatch = [...entries]
    .sort((left, right) => (
      (right.battingRuns + right.wickets * 25) - (left.battingRuns + left.wickets * 25)
      || right.battingRuns - left.battingRuns
      || right.wickets - left.wickets
    ))[0];

  return {
    manOfMatch: manOfMatch
      ? playerAwardSnapshot(match, manOfMatch.playerId, {
        battingRuns: manOfMatch.battingRuns,
        wickets: manOfMatch.wickets
      })
      : null,
    bestBowler: bestBowler
      ? playerAwardSnapshot(match, bestBowler.playerId, {
        wickets: bestBowler.wickets,
        runsConceded: bestBowler.bowlingRuns,
        overs: oversFromBalls(bestBowler.bowlingBalls)
      })
      : null
  };
}

function sanitizeDelivery(match, deliveryInput) {
  const delivery = plain(deliveryInput);
  const {
    clientRequestId: _clientRequestId,
    editedAt: _editedAt,
    editCount: _editCount,
    legalBallsBefore: _legalBallsBefore,
    ...safe
  } = delivery;
  return {
    ...safe,
    over: delivery.overNumber,
    ball: delivery.ballNumber,
    overLabel: delivery.displayBall,
    ballLabel: delivery.displayBall,
    striker: getPlayerSnapshot(match, delivery.strikerId),
    nonStriker: getPlayerSnapshot(match, delivery.nonStrikerId),
    bowler: getPlayerSnapshot(match, delivery.bowlerId)
  };
}

function summaryTeamSnapshot(teamInput) {
  const team = plain(teamInput);
  if (!team) return team;
  const { players: _players, ...summary } = team;
  return summary;
}

function resolveAwards(match) {
  const stored = plain(match.awards) || {};
  const resolve = (playerId, legacyAward) => {
    const award = playerId ? { playerId } : legacyAward;
    if (!award?.playerId) return award || null;
    const currentPlayer = playerAwardSnapshot(match, award.playerId);
    return currentPlayer ? { ...plain(award), ...currentPlayer } : plain(award);
  };
  return {
    manOfMatch: resolve(match.manOfMatchPlayerId, stored.manOfMatch),
    bestBowler: resolve(match.bestBowlerPlayerId, stored.bestBowler)
  };
}

function deriveMatchView(matchInput, options = {}) {
  const match = plain(matchInput);
  const inningsViews = [];
  const inningsPayload = [];
  let firstInningsRuns = null;

  (match.innings || []).forEach((inningsInput, index) => {
    const innings = plain(inningsInput);
    const {
      lineupEvents: _lineupEvents,
      nextSequence: _nextSequence,
      deliveries: _storedDeliveries,
      ...publicInnings
    } = innings;
    const target = index === 1 && firstInningsRuns !== null ? firstInningsRuns + 1 : null;
    const replay = replayInnings(match, innings, { target, strict: false });
    const scorecard = buildInningsScorecard(match, innings, replay);
    const publicDeliveries = options.detail === false
      ? []
      : replay.deliveries.map((delivery) => sanitizeDelivery(match, delivery));
    inningsViews.push(scorecard);
    if (index === 0) firstInningsRuns = scorecard.totalRuns;
    inningsPayload.push({
      ...publicInnings,
      status: scorecard.status,
      totalRuns: scorecard.totalRuns,
      runs: scorecard.totalRuns,
      wickets: scorecard.wickets,
      legalBalls: scorecard.legalBalls,
      overs: scorecard.overs,
      target: scorecard.target,
      requiredRuns: scorecard.requiredRuns,
      ballsRemaining: scorecard.ballsRemaining,
      currentRunRate: scorecard.currentRunRate,
      requiredRunRate: scorecard.requiredRunRate,
      terminal: scorecard.terminal,
      terminalReason: scorecard.terminalReason,
      deliveries: publicDeliveries,
      summary: {
        totalRuns: scorecard.totalRuns,
        wickets: scorecard.wickets,
        overs: scorecard.overs,
        legalBalls: scorecard.legalBalls,
        target: scorecard.target,
        requiredRuns: scorecard.requiredRuns,
        ballsRemaining: scorecard.ballsRemaining,
        currentRunRate: scorecard.currentRunRate,
        requiredRunRate: scorecard.requiredRunRate,
        terminal: scorecard.terminal,
        terminalReason: scorecard.terminalReason
      },
      battingScorecard: scorecard.battingScorecard,
      didNotBat: scorecard.didNotBat,
      bowlingScorecard: scorecard.bowlingScorecard,
      extras: scorecard.extras,
      fallOfWickets: scorecard.fallOfWickets,
      partnership: scorecard.partnership,
      striker: scorecard.striker,
      nonStriker: scorecard.nonStriker,
      currentBowler: scorecard.currentBowler,
      strikerId: scorecard.strikerId,
      nonStrikerId: scorecard.nonStrikerId,
      bowlerId: scorecard.bowlerId,
      currentStrikerId: scorecard.strikerId,
      currentNonStrikerId: scorecard.nonStrikerId,
      currentBowlerId: scorecard.bowlerId,
      needsBatter: scorecard.needsBatter,
      needsBowler: scorecard.needsBowler,
      canScore: scorecard.canScore,
      errors: scorecard.errors
    });
  });

  const result = buildResult(match, inningsViews);
  const currentIndex = Math.min(
    Math.max(0, Number(match.currentInningsIndex || 0)),
    Math.max(0, inningsViews.length - 1)
  );
  const currentInnings = inningsViews[currentIndex] || null;
  const currentInningsPayload = inningsPayload[currentIndex] || null;
  const fullTeamA = getTeamSnapshot(match, matchTeamId(match, 'teamA')) || plain(match.teamA);
  const fullTeamB = getTeamSnapshot(match, matchTeamId(match, 'teamB')) || plain(match.teamB);
  const teamA = options.detail === false ? summaryTeamSnapshot(fullTeamA) : fullTeamA;
  const teamB = options.detail === false ? summaryTeamSnapshot(fullTeamB) : fullTeamB;
  const base = {
    _id: match._id,
    title: match.title || '',
    venue: match.venue || '',
    scheduledAt: match.scheduledAt || null,
    status: match.status,
    oversPerInnings: match.oversPerInnings,
    maxOversPerBowler: Number(match.maxOversPerBowler || 0),
    maxWickets: match.maxWickets,
    teamA,
    teamB,
    teams: [teamA, teamB],
    toss: match.toss || null,
    currentInningsIndex: match.currentInningsIndex || 0,
    inningsSummaries: inningsViews.map((entry) => ({
      number: entry.number,
      status: entry.status,
      battingTeam: entry.battingTeam,
      bowlingTeam: entry.bowlingTeam,
      totalRuns: entry.totalRuns,
      wickets: entry.wickets,
      overs: entry.overs,
      legalBalls: entry.legalBalls,
      target: entry.target,
      requiredRuns: entry.requiredRuns,
      ballsRemaining: entry.ballsRemaining,
      terminal: entry.terminal,
      terminalReason: entry.terminalReason
    })),
    currentInnings: currentInnings ? {
      ...currentInningsPayload,
      ...currentInnings,
      deliveries: options.detail === false ? undefined : currentInningsPayload?.deliveries,
      battingScorecard: options.detail === false ? undefined : currentInnings.battingScorecard,
      bowlingScorecard: options.detail === false ? undefined : currentInnings.bowlingScorecard,
      didNotBat: options.detail === false ? undefined : currentInnings.didNotBat,
      lastDelivery: currentInnings.lastDelivery
        ? sanitizeDelivery(match, currentInnings.lastDelivery)
        : null
    } : null,
    result,
    awards: resolveAwards(match),
    completionReason: match.completionReason || '',
    startedAt: match.startedAt || null,
    completedAt: match.completedAt || null,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    revision: Number(match.revision || 0)
  };

  if (options.detail !== false) base.innings = inningsPayload;
  return base;
}

function buildMatchListSnapshot(match) {
  const view = deriveMatchView(match, { detail: false });
  return {
    inningsSummaries: view.inningsSummaries || [],
    currentInnings: view.currentInnings || null,
    result: view.result || null,
    awards: view.awards || { manOfMatch: null, bestBowler: null }
  };
}

function buildReferenceMatchListSnapshot(match) {
  const view = deriveMatchView(match, { detail: false });
  const compactInnings = (entry) => ({
    number: entry.number,
    status: entry.status,
    battingTeamId: entry.battingTeam?.teamId || null,
    bowlingTeamId: entry.bowlingTeam?.teamId || null,
    totalRuns: Number(entry.totalRuns || 0),
    wickets: Number(entry.wickets || 0),
    overs: entry.overs || '0.0',
    legalBalls: Number(entry.legalBalls || 0),
    target: entry.target === null ? null : Number(entry.target || 0),
    requiredRuns: entry.requiredRuns === null ? null : Number(entry.requiredRuns || 0),
    ballsRemaining: entry.ballsRemaining === null ? null : Number(entry.ballsRemaining || 0),
    terminal: Boolean(entry.terminal),
    terminalReason: entry.terminalReason || ''
  });
  const current = view.currentInnings;
  return {
    storage: 'references-v1',
    inningsSummaries: (view.inningsSummaries || []).map(compactInnings),
    currentInnings: current ? {
      ...compactInnings(current),
      strikerId: current.strikerId || null,
      nonStrikerId: current.nonStrikerId || null,
      bowlerId: current.bowlerId || null,
      needsBatter: Boolean(current.needsBatter),
      needsBowler: Boolean(current.needsBowler),
      canScore: Boolean(current.canScore),
      currentRunRate: Number(current.currentRunRate || 0),
      requiredRunRate: current.requiredRunRate === null
        ? null
        : Number(current.requiredRunRate || 0)
    } : null,
    result: resultForStorage(view.result)
  };
}

function decorateCompactResult(match, resultInput) {
  const result = plain(resultInput);
  if (!result) return null;
  if (result.tie) {
    return { ...result, winnerTeamName: '', text: 'Match tied' };
  }
  const winner = getTeamSnapshot(match, result.winnerTeamId);
  const winnerName = winner?.name || '';
  const margin = Number(result.margin || 0);
  const suffix = result.marginType === 'wickets'
    ? `wicket${margin === 1 ? '' : 's'}`
    : `run${margin === 1 ? '' : 's'}`;
  return {
    ...result,
    winnerTeamName: winnerName,
    text: winnerName ? `${winnerName} won by ${margin} ${suffix}` : ''
  };
}

function deriveCachedMatchListView(matchInput) {
  const match = plain(matchInput);
  if (!match?.listSnapshot) return deriveMatchView(match, { detail: false });
  const snapshot = plain(match.listSnapshot);
  const teamA = summaryTeamSnapshot(
    getTeamSnapshot(match, matchTeamId(match, 'teamA')) || match.teamA
  );
  const teamB = summaryTeamSnapshot(
    getTeamSnapshot(match, matchTeamId(match, 'teamB')) || match.teamB
  );
  if (snapshot.storage === 'references-v1') {
    const decorateInnings = (entry) => ({
      ...plain(entry),
      battingTeam: summaryTeamSnapshot(getTeamSnapshot(match, entry.battingTeamId)),
      bowlingTeam: summaryTeamSnapshot(getTeamSnapshot(match, entry.bowlingTeamId))
    });
    const current = snapshot.currentInnings
      ? {
        ...decorateInnings(snapshot.currentInnings),
        striker: getPlayerSnapshot(match, snapshot.currentInnings.strikerId),
        nonStriker: getPlayerSnapshot(match, snapshot.currentInnings.nonStrikerId),
        currentBowler: getPlayerSnapshot(match, snapshot.currentInnings.bowlerId),
        currentStrikerId: snapshot.currentInnings.strikerId || null,
        currentNonStrikerId: snapshot.currentInnings.nonStrikerId || null,
        currentBowlerId: snapshot.currentInnings.bowlerId || null
      }
      : null;
    return {
      _id: match._id,
      title: match.title || '',
      venue: match.venue || '',
      scheduledAt: match.scheduledAt || null,
      status: match.status,
      oversPerInnings: match.oversPerInnings,
      maxOversPerBowler: Number(match.maxOversPerBowler || 0),
      maxWickets: match.maxWickets,
      teamA,
      teamB,
      teams: [teamA, teamB],
      toss: match.toss || null,
      currentInningsIndex: match.currentInningsIndex || 0,
      inningsSummaries: (snapshot.inningsSummaries || []).map(decorateInnings),
      currentInnings: current,
      result: decorateCompactResult(match, snapshot.result),
      awards: resolveAwards(match),
      completionReason: match.completionReason || '',
      startedAt: match.startedAt || null,
      completedAt: match.completedAt || null,
      createdAt: match.createdAt,
      updatedAt: match.updatedAt,
      revision: Number(match.revision || 0)
    };
  }
  return {
    _id: match._id,
    title: match.title || '',
    venue: match.venue || '',
    scheduledAt: match.scheduledAt || null,
    status: match.status,
    oversPerInnings: match.oversPerInnings,
    maxOversPerBowler: Number(match.maxOversPerBowler || 0),
    maxWickets: match.maxWickets,
    teamA,
    teamB,
    teams: [teamA, teamB],
    toss: match.toss || null,
    currentInningsIndex: match.currentInningsIndex || 0,
    inningsSummaries: snapshot.inningsSummaries || [],
    currentInnings: snapshot.currentInnings || null,
    result: snapshot.result || null,
    awards: resolveAwards(match),
    completionReason: match.completionReason || '',
    startedAt: match.startedAt || null,
    completedAt: match.completedAt || null,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    revision: Number(match.revision || 0)
  };
}

function createSchemas(mongoose) {
  const { Schema } = mongoose;
  const playerSnapshotSchema = new Schema({
    playerId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    image: { type: String, default: '' },
    category: { type: String, default: '' },
    battingStyle: { type: String, default: '' },
    bowlingStyle: { type: String, default: '' }
  }, { _id: false });

  const teamSnapshotSchema = new Schema({
    teamId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    logo: { type: String, default: '' },
    players: { type: [playerSnapshotSchema], default: [] }
  }, { _id: false });

  const extrasSchema = new Schema({
    wide: { type: Number, default: 0, min: 0 },
    noBall: { type: Number, default: 0, min: 0 },
    bye: { type: Number, default: 0, min: 0 },
    legBye: { type: Number, default: 0, min: 0 },
    penalty: { type: Number, default: 0, min: 0 }
  }, { _id: false });

  const wicketSchema = new Schema({
    isWicket: { type: Boolean, default: true },
    kind: { type: String, required: true },
    dismissedBatterId: { type: Schema.Types.ObjectId, required: true },
    dismissedBatterName: { type: String, default: '' },
    countsAsWicket: { type: Boolean, default: true },
    creditedToBowler: { type: Boolean, default: false }
  }, { _id: false });

  const deliverySchema = new Schema({
    clientRequestId: { type: String, default: '', trim: true },
    sequence: { type: Number, required: true, min: 1 },
    strikerId: { type: Schema.Types.ObjectId, default: null },
    strikerName: { type: String, default: '' },
    nonStrikerId: { type: Schema.Types.ObjectId, default: null },
    nonStrikerName: { type: String, default: '' },
    bowlerId: { type: Schema.Types.ObjectId, default: null },
    bowlerName: { type: String, default: '' },
    runsOffBat: { type: Number, default: 0, min: 0 },
    extras: { type: extrasSchema, default: () => ({}) },
    runningRuns: { type: Number, default: 0, min: 0 },
    totalRuns: { type: Number, default: 0, min: 0 },
    isLegal: { type: Boolean, default: true },
    wicket: { type: wicketSchema, default: undefined },
    note: { type: String, default: '', maxlength: 500 },
    createdAt: { type: Date, default: Date.now },
    editedAt: { type: Date, default: null },
    editCount: { type: Number, default: 0, min: 0 }
  });

  const lineupEventSchema = new Schema({
    afterSequence: { type: Number, required: true, min: 0 },
    strikerId: { type: Schema.Types.ObjectId, default: null },
    nonStrikerId: { type: Schema.Types.ObjectId, default: null },
    bowlerId: { type: Schema.Types.ObjectId, default: null },
    createdAt: { type: Date, default: Date.now }
  });

  const inningsSchema = new Schema({
    number: { type: Number, required: true, min: 1, max: 2 },
    battingTeamId: { type: Schema.Types.ObjectId, required: true },
    battingTeamName: { type: String, default: '' },
    battingTeamLogo: { type: String, default: '' },
    bowlingTeamId: { type: Schema.Types.ObjectId, required: true },
    bowlingTeamName: { type: String, default: '' },
    bowlingTeamLogo: { type: String, default: '' },
    status: { type: String, enum: INNINGS_STATUSES, default: 'ready' },
    lineupEvents: { type: [lineupEventSchema], default: [] },
    deliveries: { type: [deliverySchema], default: [] },
    nextSequence: { type: Number, default: 1, min: 1 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null }
  });

  const matchSchema = new Schema({
    title: { type: String, default: '', trim: true, maxlength: 160 },
    venue: { type: String, default: '', trim: true, maxlength: 160 },
    scheduledAt: { type: Date, default: Date.now },
    status: { type: String, enum: MATCH_STATUSES, default: 'scheduled', index: true },
    oversPerInnings: { type: Number, required: true, min: 1, max: 100, default: 20 },
    maxOversPerBowler: { type: Number, min: 1, max: 100, default: null },
    maxWickets: { type: Number, required: true, min: 1, max: 10, default: 10 },
    teamAId: { type: Schema.Types.ObjectId, ref: 'Team', default: null, index: true },
    teamBId: { type: Schema.Types.ObjectId, ref: 'Team', default: null, index: true },
    teamAPlayerIds: [{ type: Schema.Types.ObjectId, ref: 'Player' }],
    teamBPlayerIds: [{ type: Schema.Types.ObjectId, ref: 'Player' }],
    teamA: { type: teamSnapshotSchema, default: undefined },
    teamB: { type: teamSnapshotSchema, default: undefined },
    toss: {
      winnerTeamId: { type: Schema.Types.ObjectId, default: null },
      decision: { type: String, enum: ['bat', 'bowl', ''], default: '' }
    },
    innings: { type: [inningsSchema], default: [] },
    currentInningsIndex: { type: Number, default: 0, min: 0, max: 1 },
    result: { type: Schema.Types.Mixed, default: null },
    manOfMatchPlayerId: { type: Schema.Types.ObjectId, ref: 'Player', default: null },
    bestBowlerPlayerId: { type: Schema.Types.ObjectId, ref: 'Player', default: null },
    awards: { type: Schema.Types.Mixed, default: undefined },
    listSnapshot: { type: Schema.Types.Mixed, default: null },
    completionReason: { type: String, enum: ['', 'auto', 'manual'], default: '' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null }
  }, {
    timestamps: true,
    versionKey: 'revision',
    optimisticConcurrency: true,
    minimize: false
  });

  matchSchema.index({ status: 1, scheduledAt: -1 });
  matchSchema.index({ updatedAt: -1 });
  matchSchema.index({ 'innings.deliveries.clientRequestId': 1 });
  matchSchema.pre('save', function updateListSnapshot(next) {
    try {
      if (this.teamAId && this.teamBId && !this.teamA && !this.teamB) {
        this.listSnapshot = buildReferenceMatchListSnapshot(this);
      } else {
        this.listSnapshot = buildMatchListSnapshot(this);
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  return matchSchema;
}

function timingSafePinEqual(received, configured) {
  const left = Buffer.from(String(received || ''));
  const right = Buffer.from(String(configured || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

const SCORER_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function scryptPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashScorerPassword(password) {
  const normalized = String(password || '');
  if (normalized.length < 8 || normalized.length > 128) {
    throw new ScoringError('New scorer password must be between 8 and 128 characters');
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = await scryptPassword(normalized, salt);
  return `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

async function verifyScorerPassword(password, storedHash) {
  const [algorithm, saltValue, hashValue] = String(storedHash || '').split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, 'base64url');
    const actual = await scryptPassword(String(password || ''), Buffer.from(saltValue, 'base64url'));
    return expected.length === actual.length
      && expected.length > 0
      && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

async function loadScorerCredential(Settings) {
  const settings = await Settings.findOne().select('+scorerPasswordHash').lean();
  const storedHash = String(settings?.scorerPasswordHash || '');
  const fallbackPin = storedHash ? '' : String(process.env.SCORER_PIN || '');
  return {
    settingsId: settings?._id || null,
    storedHash,
    fallbackPin,
    configured: Boolean(storedHash || fallbackPin)
  };
}

function scorerCredentialFingerprint(credential) {
  const source = credential.storedHash || credential.fallbackPin;
  return crypto.createHash('sha256').update(`rmpl-scorer:${source}`).digest('base64url').slice(0, 24);
}

function scorerTokenSigningKey(credential) {
  return process.env.SCORER_SESSION_SECRET
    || crypto.createHash('sha256')
      .update(`rmpl-session:${credential.storedHash || credential.fallbackPin}`)
      .digest();
}

function issueScorerToken(credential) {
  const expiresAt = Date.now() + SCORER_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({
    exp: expiresAt,
    credential: scorerCredentialFingerprint(credential)
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', scorerTokenSigningKey(credential))
    .update(payload)
    .digest('base64url');
  return {
    token: `${payload}.${signature}`,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function verifyScorerToken(token, credential) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !credential.configured) return false;
  const expectedSignature = crypto
    .createHmac('sha256', scorerTokenSigningKey(credential))
    .update(payload)
    .digest();
  let receivedSignature;
  let parsed;
  try {
    receivedSignature = Buffer.from(signature, 'base64url');
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  return receivedSignature.length === expectedSignature.length
    && crypto.timingSafeEqual(receivedSignature, expectedSignature)
    && Number(parsed.exp) > Date.now()
    && parsed.credential === scorerCredentialFingerprint(credential);
}

async function verifyScorerCredential(password, credential) {
  if (!credential.configured) return false;
  if (credential.storedHash) return verifyScorerPassword(password, credential.storedHash);
  return timingSafePinEqual(password, credential.fallbackPin);
}

function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof ScoringError) {
        return res.status(error.status).json({
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        });
      }
      if (error?.name === 'VersionError') {
        return res.status(409).json({
          message: 'This match changed in another scorer session. Refresh it and try again.'
        });
      }
      if (error?.name === 'CastError') {
        return res.status(400).json({ message: 'Invalid match or player id' });
      }
      if (error?.name === 'ValidationError') {
        const firstMessage = Object.values(error.errors || {})[0]?.message;
        return res.status(400).json({ message: firstMessage || 'Invalid scoring data' });
      }
      if (error?.code === 11000) {
        return res.status(409).json({ message: 'This scoring request was already processed' });
      }
      console.error('Scoring API error:', error);
      return res.status(500).json({ message: 'Unable to process scoring request' });
    }
  };
}

function requestedRevision(req) {
  const raw = req.body?.expectedRevision ?? req.get('x-match-revision');
  if (raw === undefined || raw === null || raw === '') return null;
  const revision = Number(String(raw).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(revision) || revision < 0) {
    throw new ScoringError('expectedRevision must be a non-negative whole number');
  }
  return revision;
}

function assertRevision(match, req) {
  const expected = requestedRevision(req);
  if (expected !== null && expected !== Number(match.revision || 0)) {
    throw new ScoringError(
      'This match changed in another scorer session. Refresh it and try again.',
      409,
      { currentRevision: Number(match.revision || 0) }
    );
  }
}

function resolvedTeam(team, players) {
  return {
    teamId: team._id,
    name: team.name,
    logo: team.logo || '',
    players: players.map((player) => ({
      playerId: player._id,
      name: player.name,
      image: player.image || '',
      category: player.category || '',
      battingStyle: player.battingStyle || '',
      bowlingStyle: player.bowlingStyle || ''
    }))
  };
}

function collectHistoricPlayerAssignments(matchInput) {
  const match = plain(matchInput);
  const assignments = new Map();
  const assign = (playerId, teamId) => {
    const playerKey = idOf(playerId);
    const teamKey = idOf(teamId);
    if (playerKey && teamKey && !assignments.has(playerKey)) assignments.set(playerKey, teamKey);
  };

  [plain(match.teamA), plain(match.teamB)].forEach((team) => {
    (team?.players || []).forEach((player) => assign(player.playerId, team.teamId));
  });
  (match.innings || []).forEach((inningsInput) => {
    const innings = plain(inningsInput);
    (innings.lineupEvents || []).forEach((event) => {
      assign(event.strikerId, innings.battingTeamId);
      assign(event.nonStrikerId, innings.battingTeamId);
      assign(event.bowlerId, innings.bowlingTeamId);
    });
    (innings.deliveries || []).forEach((delivery) => {
      assign(delivery.strikerId, innings.battingTeamId);
      assign(delivery.nonStrikerId, innings.battingTeamId);
      assign(delivery.bowlerId, innings.bowlingTeamId);
      assign(delivery.wicket?.dismissedBatterId, innings.battingTeamId);
    });
  });
  assign(match.awards?.manOfMatch?.playerId, match.awards?.manOfMatch?.teamId);
  assign(match.awards?.bestBowler?.playerId, match.awards?.bestBowler?.teamId);
  return assignments;
}

async function hydrateMatchReferences(matchesInput, { Team, Player }) {
  const matches = (Array.isArray(matchesInput) ? matchesInput : [matchesInput]).filter(Boolean);
  if (!matches.length) return matchesInput;

  const teamIds = new Set();
  const historicPlayerIds = new Set();
  const assignmentsByMatch = new Map();
  const frozenRostersByMatch = new Map();
  matches.forEach((match) => {
    [matchTeamId(match, 'teamA'), matchTeamId(match, 'teamB')]
      .map(idOf)
      .filter(Boolean)
      .forEach((teamId) => teamIds.add(teamId));
    const assignments = collectHistoricPlayerAssignments(match);
    assignmentsByMatch.set(idOf(match._id), assignments);
    assignments.forEach((_teamId, playerId) => historicPlayerIds.add(playerId));
    [match.manOfMatchPlayerId, match.bestBowlerPlayerId]
      .map(idOf)
      .filter(Boolean)
      .forEach((playerId) => historicPlayerIds.add(playerId));
    const frozenRosters = new Map();
    if (match.status !== 'scheduled') {
      [
        ['teamA', match.teamAPlayerIds],
        ['teamB', match.teamBPlayerIds]
      ].forEach(([side, playerIds]) => {
        const teamId = idOf(matchTeamId(match, side));
        const rosterIds = new Set((playerIds || []).map(idOf).filter(Boolean));
        if (teamId && rosterIds.size) {
          frozenRosters.set(teamId, rosterIds);
          rosterIds.forEach((playerId) => historicPlayerIds.add(playerId));
        }
      });
    }
    frozenRostersByMatch.set(idOf(match._id), frozenRosters);
  });

  const teamIdList = [...teamIds];
  const historicIdList = [...historicPlayerIds];
  const [teams, players] = await Promise.all([
    Team.find({ _id: { $in: teamIdList } }).select('_id name logo').lean(),
    Player.find({
      $or: [
        { teamId: { $in: teamIdList }, sold: true },
        ...(historicIdList.length ? [{ _id: { $in: historicIdList } }] : [])
      ]
    })
      .select('_id name image category battingStyle bowlingStyle teamId sold')
      .sort({ name: 1 })
      .lean()
  ]);
  const teamsById = new Map(teams.map((team) => [idOf(team._id), team]));
  const playersById = new Map(players.map((player) => [idOf(player._id), player]));

  matches.forEach((match) => {
    const assignments = assignmentsByMatch.get(idOf(match._id)) || new Map();
    const frozenRosters = frozenRostersByMatch.get(idOf(match._id)) || new Map();
    const legacyTeams = [plain(match.teamA), plain(match.teamB)].filter(Boolean);
    const resolved = ['teamA', 'teamB'].map((side) => {
      const teamId = idOf(matchTeamId(match, side));
      const currentTeam = teamsById.get(teamId);
      const legacyTeam = legacyTeams.find((team) => sameId(team.teamId, teamId));
      if (!currentTeam && legacyTeam) return legacyTeam;

      const rosterById = new Map();
      const frozenRosterIds = frozenRosters.get(teamId);
      if (frozenRosterIds?.size) {
        frozenRosterIds.forEach((playerId) => {
          if (playersById.has(playerId)) rosterById.set(playerId, playersById.get(playerId));
        });
      } else {
        players.forEach((player) => {
          const assignedHistoricTeam = assignments.get(idOf(player._id));
          const belongsToCurrentTeam = sameId(player.teamId, teamId) && player.sold === true;
          const belongsToHistoricTeam = assignedHistoricTeam === teamId;
          if (belongsToHistoricTeam || (belongsToCurrentTeam && !assignedHistoricTeam)) {
            rosterById.set(idOf(player._id), player);
          }
        });
      }
      assignments.forEach((assignedTeamId, playerId) => {
        if (assignedTeamId === teamId && playersById.has(playerId)) {
          rosterById.set(playerId, playersById.get(playerId));
        }
      });
      const team = currentTeam || {
        _id: teamId,
        name: legacyTeam?.name || 'Unavailable team',
        logo: legacyTeam?.logo || ''
      };
      return resolvedTeam(team, [...rosterById.values()]);
    });
    attachResolvedTeams(match, resolved);
  });

  return Array.isArray(matchesInput) ? matches : matches[0];
}

function inningsForTeams(number, battingTeam, bowlingTeam) {
  return {
    number,
    battingTeamId: battingTeam.teamId,
    bowlingTeamId: bowlingTeam.teamId,
    status: 'live',
    startedAt: new Date(),
    lineupEvents: [],
    deliveries: [],
    nextSequence: 1
  };
}

function currentInningsDocument(match) {
  const innings = match.innings?.[Number(match.currentInningsIndex || 0)];
  if (!innings) throw new ScoringError('This match does not have an active innings', 409);
  return innings;
}

function replayAll(match, strict = true) {
  const results = [];
  let firstRuns = null;
  match.innings.forEach((innings, index) => {
    const target = index === 1 && firstRuns !== null ? firstRuns + 1 : null;
    const replay = replayInnings(match, innings, { target, strict });
    results.push(replay);
    if (index === 0) firstRuns = replay.totalRuns;
  });
  return results;
}

function validateLineup(match, innings, replay, values) {
  const battingIds = inningsPlayerIds(match, innings, true);
  const bowlingIds = inningsPlayerIds(match, innings, false);
  if (!values.strikerId || !battingIds.has(idOf(values.strikerId))) {
    throw new ScoringError('Select a striker from the batting team');
  }
  if (!values.nonStrikerId || !battingIds.has(idOf(values.nonStrikerId))) {
    throw new ScoringError('Select a non-striker from the batting team');
  }
  if (sameId(values.strikerId, values.nonStrikerId)) {
    throw new ScoringError('Striker and non-striker must be different players');
  }
  if (!values.bowlerId || !bowlingIds.has(idOf(values.bowlerId))) {
    throw new ScoringError('Select a bowler from the bowling team');
  }
  assertBowlerWithinLimit(match, replay, values.bowlerId);
  if (replay.dismissedIds.has(idOf(values.strikerId))
    || replay.dismissedIds.has(idOf(values.nonStrikerId))) {
    throw new ScoringError('A dismissed player cannot return to the crease');
  }
}

function bowlerLegalBalls(replay, bowlerId) {
  return (replay?.deliveries || []).reduce((total, delivery) => (
    total + (sameId(delivery.bowlerId, bowlerId) && delivery.isLegal ? 1 : 0)
  ), 0);
}

function maximumBowlerLegalBalls(replays) {
  const totals = new Map();
  (replays || []).forEach((replay) => {
    (replay?.deliveries || []).forEach((delivery) => {
      if (!delivery.isLegal || !delivery.bowlerId) return;
      const bowlerId = idOf(delivery.bowlerId);
      totals.set(bowlerId, (totals.get(bowlerId) || 0) + 1);
    });
  });
  return Math.max(0, ...totals.values());
}

function assertBowlerWithinLimit(match, replay, bowlerId) {
  const maximumOvers = Number(match?.maxOversPerBowler || 0);
  if (!maximumOvers) return;
  const usedBalls = bowlerLegalBalls(replay, bowlerId);
  if (usedBalls >= maximumOvers * 6) {
    throw new ScoringError(
      `This bowler has completed the maximum ${maximumOvers} over${maximumOvers === 1 ? '' : 's'} allowed`
    );
  }
}

function appendLineupEvent(match, innings, payload) {
  const inningsIndex = match.innings.findIndex((entry) => entry === innings
    || Number(entry.number) === Number(innings.number));
  const target = inningsIndex === 1
    ? replayInnings(match, match.innings[0], { strict: true }).totalRuns + 1
    : null;
  const replay = replayInnings(match, innings, { target, strict: true });
  if (replay.terminal) throw new ScoringError('This innings is already complete', 409);
  const current = replay.state;
  const values = {
    strikerId: payload.strikerId ?? current.strikerId,
    nonStrikerId: payload.nonStrikerId ?? current.nonStrikerId,
    bowlerId: payload.bowlerId ?? current.bowlerId
  };
  validateLineup(match, innings, replay, values);
  innings.lineupEvents.push({
    afterSequence: replay.lastSequence,
    strikerId: values.strikerId,
    nonStrikerId: values.nonStrikerId,
    bowlerId: values.bowlerId,
    createdAt: new Date()
  });
  return values;
}

function findDelivery(match, deliveryId) {
  for (let inningsIndex = 0; inningsIndex < match.innings.length; inningsIndex += 1) {
    const innings = match.innings[inningsIndex];
    const deliveryIndex = innings.deliveries.findIndex((delivery) => sameId(delivery._id, deliveryId));
    if (deliveryIndex >= 0) return { innings, inningsIndex, deliveryIndex };
  }
  return null;
}

function resultForStorage(result) {
  if (!result) return null;
  return {
    winnerTeamId: result.winnerTeamId || null,
    tie: Boolean(result.tie),
    marginType: result.marginType || '',
    margin: Number(result.margin || 0)
  };
}

function clearStoredAwards(match) {
  match.manOfMatchPlayerId = null;
  match.bestBowlerPlayerId = null;
  if (match.teamAId && match.teamBId) match.awards = undefined;
  else match.awards = { manOfMatch: null, bestBowler: null };
}

function setAutomaticCompletion(match) {
  const replays = replayAll(match, true);
  replays.forEach((replay, index) => {
    if (replay.terminal) {
      match.innings[index].status = 'completed';
      match.innings[index].completedAt = match.innings[index].completedAt || new Date();
    }
  });

  const secondReplay = replays[1];
  if (secondReplay?.terminal
    && !(match.status === 'completed' && match.completionReason === 'manual')) {
    match.status = 'awaiting_awards';
    match.completionReason = '';
    match.completedAt = null;
    match.result = resultForStorage(deriveMatchView(match).result);
    clearStoredAwards(match);
  }
  return replays;
}

function deriveAutomaticAwardsFromMatchView(match, view) {
  const inningsViews = (view.innings || []).map((innings) => ({
    battingTeam: getTeamSnapshot(match, innings.battingTeamId),
    bowlingTeam: getTeamSnapshot(match, innings.bowlingTeamId),
    battingScorecard: innings.battingScorecard || [],
    bowlingScorecard: innings.bowlingScorecard || []
  }));
  return deriveAutomaticAwards(match, inningsViews);
}

function refreshStoredResultAndAwards(match, overrides = {}) {
  const view = deriveMatchView(match);
  match.result = resultForStorage(view.result);
  const automatic = deriveAutomaticAwardsFromMatchView(match, view);
  const manOfMatch = overrides.manOfMatchPlayerId
    ? playerAwardSnapshot(match, overrides.manOfMatchPlayerId)
    : automatic.manOfMatch;
  const bestBowler = overrides.bestBowlerPlayerId
    ? playerAwardSnapshot(match, overrides.bestBowlerPlayerId)
    : automatic.bestBowler;
  if (overrides.manOfMatchPlayerId && !manOfMatch) {
    throw new ScoringError('Man of the match must be selected from this match');
  }
  if (overrides.bestBowlerPlayerId && !bestBowler) {
    throw new ScoringError('Best bowler must be selected from this match');
  }
  if (overrides.bestBowlerPlayerId) {
    const eligibleBowlerIds = new Set(
      (view.innings || []).flatMap((innings) => (innings.bowlingScorecard || [])
        .filter((entry) => entry.balls || entry.runs || entry.wickets)
        .map((entry) => idOf(entry.playerId)))
    );
    if (!eligibleBowlerIds.has(idOf(overrides.bestBowlerPlayerId))) {
      throw new ScoringError('Best bowler must be a player who bowled in this match');
    }
  }
  match.manOfMatchPlayerId = manOfMatch?.playerId || null;
  match.bestBowlerPlayerId = bestBowler?.playerId || null;
  if (match.teamAId && match.teamBId) {
    match.awards = undefined;
  }
}

function markAutoStateAfterCorrection(match) {
  const replays = replayAll(match, true);
  if (match.innings.length > 1 && !replays[0]?.terminal) {
    throw new ScoringError(
      'This correction would make the first innings unfinished after the chase has started',
      409
    );
  }

  const currentIndex = Number(match.currentInningsIndex || 0);
  const currentReplay = replays[currentIndex];
  if (currentReplay && !currentReplay.terminal) {
    match.innings[currentIndex].status = 'live';
    match.innings[currentIndex].completedAt = null;
    match.status = 'live';
    match.completionReason = '';
    match.completedAt = null;
    match.result = null;
    clearStoredAwards(match);
  }

  setAutomaticCompletion(match);
  if (match.status === 'completed') {
    refreshStoredResultAndAwards(match, {
      manOfMatchPlayerId: match.manOfMatchPlayerId || match.awards?.manOfMatch?.playerId,
      bestBowlerPlayerId: match.bestBowlerPlayerId || match.awards?.bestBowler?.playerId
    });
  }
}

function statusSortExpression() {
  return { status: 1, scheduledAt: -1, updatedAt: -1 };
}

function registerScoringRoutes(app, {
  mongoose,
  Team,
  Player,
  Settings
}) {
  if (!Settings) throw new Error('Settings model is required for scorer authentication');
  const CricketMatch = mongoose.models.CricketMatch
    || mongoose.model('CricketMatch', createSchemas(mongoose));
  const hydrate = (matches) => hydrateMatchReferences(matches, { Team, Player });
  const findHydratedMatchById = async (matchId, { lean = false } = {}) => {
    const query = CricketMatch.findById(matchId);
    const match = lean ? await query.lean() : await query;
    if (match) await hydrate(match);
    return match;
  };
  const authenticateRequest = async (req) => {
    const credential = await loadScorerCredential(Settings);
    if (!credential.configured) {
      throw new ScoringError('Scorer access is not configured', 503);
    }
    const token = req.get('x-scorer-token');
    if (token && verifyScorerToken(token, credential)) {
      req.scorerCredential = credential;
      return;
    }
    const password = req.get('x-scorer-pin') || req.get('x-scorer-password');
    if (await verifyScorerCredential(password, credential)) {
      req.scorerCredential = credential;
      return;
    }
    throw new ScoringError('Invalid or expired scorer credentials', 401);
  };
  const authRoute = (handler) => route(async (req, res) => {
    await authenticateRequest(req);
    await handler(req, res);
  });

  app.get('/api/scoring/options', route(async (_req, res) => {
    const [teams, players] = await Promise.all([
      Team.find().sort({ name: 1 }).lean(),
      Player.find({ teamId: { $ne: null }, sold: true })
        .select('_id name image category battingStyle bowlingStyle teamId')
        .sort({ name: 1 })
        .lean()
    ]);
    const playersByTeam = new Map();
    players.forEach((player) => {
      const key = idOf(player.teamId);
      const list = playersByTeam.get(key) || [];
      list.push(player);
      playersByTeam.set(key, list);
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      teams: teams.map((team) => ({
        _id: team._id,
        id: team._id,
        name: team.name,
        logo: team.logo || '',
        players: (playersByTeam.get(idOf(team._id)) || []).map((player) => ({
          _id: player._id,
          id: player._id,
          name: player.name,
          image: player.image || '',
          category: player.category || '',
          battingStyle: player.battingStyle || '',
          bowlingStyle: player.bowlingStyle || ''
        }))
      }))
    });
  }));

  app.post('/api/scorer/session', route(async (req, res) => {
    const credential = await loadScorerCredential(Settings);
    if (!credential.configured) {
      throw new ScoringError('Scorer access is not configured', 503);
    }
    const suppliedToken = req.get('x-scorer-token');
    const password = req.body?.password ?? req.body?.pin;
    const authenticated = suppliedToken
      ? verifyScorerToken(suppliedToken, credential)
      : await verifyScorerCredential(password, credential);
    if (!authenticated) {
      throw new ScoringError('Invalid or expired scorer credentials', 401);
    }
    const session = issueScorerToken(credential);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authenticated: true, ...session });
  }));

  app.patch('/api/scorer/password', authRoute(async (req, res) => {
    const scorerPasswordHash = await hashScorerPassword(req.body?.newPassword);
    const settings = await Settings.findOneAndUpdate(
      {},
      { $set: { scorerPasswordHash } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).select('_id');
    const credential = {
      settingsId: settings?._id || null,
      storedHash: scorerPasswordHash,
      fallbackPin: '',
      configured: true
    };
    const session = issueScorerToken(credential);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      changed: true,
      message: 'Scorer password changed successfully',
      ...session
    });
  }));

  app.get('/api/matches', route(async (req, res) => {
    const allowedStatuses = new Set(MATCH_STATUSES);
    const requestedStatuses = String(req.query.status || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => allowedStatuses.has(entry));
    const expandedStatuses = requestedStatuses.flatMap((status) => (
      status === 'live' ? ['live', 'awaiting_awards'] : [status]
    ));
    const filter = expandedStatuses.length ? { status: { $in: [...new Set(expandedStatuses)] } } : {};
    const page = positiveInteger(req.query.page, 'Page', 1);
    const limit = Math.min(100, positiveInteger(req.query.limit, 'Limit', 30));
    const [matches, total] = await Promise.all([
      CricketMatch.find(filter)
        .select([
          '_id title venue scheduledAt status oversPerInnings maxOversPerBowler maxWickets',
          'teamAId teamBId teamAPlayerIds teamBPlayerIds',
          'teamA.teamId teamA.name teamA.logo',
          'teamB.teamId teamB.name teamB.logo',
          'manOfMatchPlayerId bestBowlerPlayerId awards',
          'toss currentInningsIndex listSnapshot completionReason',
          'startedAt completedAt createdAt updatedAt revision'
        ].join(' '))
        .sort(statusSortExpression())
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CricketMatch.countDocuments(filter)
    ]);
    const missingSnapshotIds = matches
      .filter((match) => !match.listSnapshot)
      .map((match) => match._id);
    const fallbackMatches = missingSnapshotIds.length
      ? await CricketMatch.find({ _id: { $in: missingSnapshotIds } }).lean()
      : [];
    const fallbackById = new Map(
      fallbackMatches.map((match) => [idOf(match._id), match])
    );
    await Promise.all([hydrate(matches), hydrate(fallbackMatches)]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      matches: matches.map((match) => (
        match.listSnapshot
          ? deriveCachedMatchListView(match)
          : deriveMatchView(fallbackById.get(idOf(match._id)) || match, { detail: false })
      )),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    });
  }));

  app.post('/api/matches', authRoute(async (req, res) => {
    const teamAId = req.body?.teamAId;
    const teamBId = req.body?.teamBId;
    if (!teamAId || !teamBId || sameId(teamAId, teamBId)) {
      throw new ScoringError('Select two different teams');
    }
    const [teams, players] = await Promise.all([
      Team.find({ _id: { $in: [teamAId, teamBId] } }).lean(),
      Player.find({ teamId: { $in: [teamAId, teamBId] }, sold: true })
        .select('_id name image category battingStyle bowlingStyle teamId')
        .sort({ name: 1 })
        .lean()
    ]);
    if (teams.length !== 2) throw new ScoringError('One or both selected teams no longer exist', 404);
    const teamA = teams.find((team) => sameId(team._id, teamAId));
    const teamB = teams.find((team) => sameId(team._id, teamBId));
    const teamAPlayers = players.filter((player) => sameId(player.teamId, teamAId));
    const teamBPlayers = players.filter((player) => sameId(player.teamId, teamBId));
    if (teamAPlayers.length < 2 || teamBPlayers.length < 2) {
      throw new ScoringError('Each team needs at least two assigned players before a match can be created');
    }

    const squadWicketLimit = Math.min(10, teamAPlayers.length - 1, teamBPlayers.length - 1);
    const oversPerInnings = positiveInteger(req.body.oversPerInnings, 'Overs per innings', 20);
    if (oversPerInnings > 100) throw new ScoringError('Overs per innings cannot exceed 100');
    const maxOversPerBowler = positiveInteger(
      req.body.maxOversPerBowler,
      'Maximum overs per bowler',
      Math.max(1, Math.ceil(oversPerInnings / 5))
    );
    if (maxOversPerBowler > oversPerInnings) {
      throw new ScoringError('Maximum overs per bowler cannot exceed the innings length');
    }
    const minimumBowlers = Math.ceil(oversPerInnings / maxOversPerBowler);
    if (teamAPlayers.length < minimumBowlers || teamBPlayers.length < minimumBowlers) {
      throw new ScoringError(
        `Each team needs at least ${minimumBowlers} players available to satisfy the bowler over limit`
      );
    }
    const requestedMaxWickets = positiveInteger(
      req.body.maxWickets,
      'Maximum wickets',
      squadWicketLimit
    );
    const maxWickets = Math.min(requestedMaxWickets, squadWicketLimit);

    const match = await CricketMatch.create({
      title: String(req.body.title || '').trim(),
      venue: String(req.body.venue || '').trim(),
      scheduledAt: req.body.scheduledAt ? new Date(req.body.scheduledAt) : new Date(),
      oversPerInnings,
      maxOversPerBowler,
      maxWickets,
      teamAId: teamA._id,
      teamBId: teamB._id,
      toss: {
        winnerTeamId: req.body.tossWinnerTeamId || null,
        decision: req.body.tossDecision || ''
      }
    });
    attachResolvedTeams(match, [
      resolvedTeam(teamA, teamAPlayers),
      resolvedTeam(teamB, teamBPlayers)
    ]);
    res.status(201).json({ message: 'Match created', match: deriveMatchView(match) });
  }));

  app.get('/api/matches/:id', route(async (req, res) => {
    const match = await findHydratedMatchById(req.params.id, { lean: true });
    if (!match) throw new ScoringError('Match not found', 404);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ match: deriveMatchView(match) });
  }));

  app.patch('/api/matches/:id', authRoute(async (req, res) => {
    const match = await findHydratedMatchById(req.params.id);
    if (!match) throw new ScoringError('Match not found', 404);
    assertRevision(match, req);
    if (req.body.title !== undefined) match.title = String(req.body.title).trim();
    if (req.body.venue !== undefined) match.venue = String(req.body.venue).trim();
    if (req.body.scheduledAt !== undefined) match.scheduledAt = new Date(req.body.scheduledAt);
    if (req.body.oversPerInnings !== undefined) {
      if (match.status !== 'scheduled') {
        throw new ScoringError('Overs can only be changed before the match starts', 409);
      }
      match.oversPerInnings = positiveInteger(req.body.oversPerInnings, 'Overs per innings');
    }
    if (req.body.maxOversPerBowler !== undefined) {
      if (match.status === 'completed') {
        throw new ScoringError('Bowler over limits cannot be changed after the match is completed', 409);
      }
      const maximum = positiveInteger(req.body.maxOversPerBowler, 'Maximum overs per bowler');
      if (maximum > Number(match.oversPerInnings || 0)) {
        throw new ScoringError('Maximum overs per bowler cannot exceed the innings length');
      }
      const minimumUsedOvers = Math.ceil(maximumBowlerLegalBalls(replayAll(match, false)) / 6);
      if (maximum < minimumUsedOvers) {
        throw new ScoringError(
          `The limit cannot be below ${minimumUsedOvers} over${minimumUsedOvers === 1 ? '' : 's'} because a bowler has already bowled that many`,
          409
        );
      }
      const minimumBowlers = Math.ceil(Number(match.oversPerInnings) / maximum);
      const snapshots = getTeamSnapshots(match);
      if (snapshots.some((team) => (team.players?.length || 0) < minimumBowlers)) {
        throw new ScoringError(
          `Each team needs at least ${minimumBowlers} players available for this bowler limit`
        );
      }
      match.maxOversPerBowler = maximum;
    }
    if (match.status === 'completed'
      && (req.body.manOfMatchPlayerId || req.body.bestBowlerPlayerId)) {
      refreshStoredResultAndAwards(match, req.body);
    }
    await match.save();
    res.json({ message: 'Match updated', match: deriveMatchView(match) });
  }));

  app.delete('/api/matches/:id', authRoute(async (req, res) => {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) throw new ScoringError('Match record not found', 404);
    await match.deleteOne();
    res.json({
      deleted: true,
      matchId: idOf(match._id),
      message: 'Match record deleted permanently'
    });
  }));

  app.post('/api/matches/:id/start', authRoute(async (req, res) => {
    const match = await findHydratedMatchById(req.params.id);
    if (!match) throw new ScoringError('Match not found', 404);
    assertRevision(match, req);
    if (match.status !== 'scheduled') throw new ScoringError('This match has already started', 409);
    const battingTeamId = req.body.battingTeamId
      || (req.body.tossDecision === 'bat' ? req.body.tossWinnerTeamId : null);
    const battingTeam = getTeamSnapshot(match, battingTeamId);
    if (!battingTeam) throw new ScoringError('Select which team bats first');
    const bowlingTeam = getTeamSnapshots(match).find((team) => !sameId(team.teamId, battingTeamId));
    const teamA = getTeamSnapshot(match, matchTeamId(match, 'teamA'));
    const teamB = getTeamSnapshot(match, matchTeamId(match, 'teamB'));
    if ((teamA?.players?.length || 0) < 2 || (teamB?.players?.length || 0) < 2) {
      throw new ScoringError('Each team needs at least two assigned players before the match can start');
    }
    const configuredBowlerOvers = Number(match.maxOversPerBowler || 0);
    if (configuredBowlerOvers) {
      const minimumBowlers = Math.ceil(Number(match.oversPerInnings) / configuredBowlerOvers);
      if ((teamA?.players?.length || 0) < minimumBowlers
        || (teamB?.players?.length || 0) < minimumBowlers) {
        throw new ScoringError(
          `Each team needs at least ${minimumBowlers} players available to satisfy the bowler over limit`
        );
      }
    }
    match.teamAPlayerIds = (teamA?.players || []).map((player) => player.playerId);
    match.teamBPlayerIds = (teamB?.players || []).map((player) => player.playerId);
    match.maxWickets = Math.min(
      Number(match.maxWickets || 10),
      teamA.players.length - 1,
      teamB.players.length - 1
    );
    match.innings = [inningsForTeams(1, battingTeam, bowlingTeam)];
    match.currentInningsIndex = 0;
    match.status = 'live';
    match.startedAt = new Date();
    match.toss = {
      winnerTeamId: req.body.tossWinnerTeamId || match.toss?.winnerTeamId || null,
      decision: req.body.tossDecision || match.toss?.decision || ''
    };
    if (req.body.strikerId || req.body.nonStrikerId || req.body.bowlerId) {
      appendLineupEvent(match, match.innings[0], req.body);
    }
    await match.save();
    res.json({ message: 'Match started', match: deriveMatchView(match) });
  }));

  app.patch('/api/matches/:id/lineup', authRoute(async (req, res) => {
    const match = await findHydratedMatchById(req.params.id);
    if (!match) throw new ScoringError('Match not found', 404);
    assertRevision(match, req);
    if (match.status !== 'live') throw new ScoringError('Only a live match can be scored', 409);
    const innings = currentInningsDocument(match);
    if (innings.status === 'completed') throw new ScoringError('This innings is complete', 409);
    appendLineupEvent(match, innings, req.body);
    await match.save();
    res.json({ message: 'Lineup updated', match: deriveMatchView(match) });
  }));

  app.post('/api/matches/:id/deliveries', authRoute(async (req, res) => {
    const match = await findHydratedMatchById(req.params.id);
    if (!match) throw new ScoringError('Match not found', 404);
    const clientRequestId = String(req.body.clientRequestId || '').trim();
    if (!clientRequestId) throw new ScoringError('clientRequestId is required to prevent duplicate balls');
    const duplicate = match.innings.some((innings) => innings.deliveries
      .some((delivery) => delivery.clientRequestId === clientRequestId));
    if (duplicate) {
      return res.json({ message: 'Delivery already recorded', deduplicated: true, match: deriveMatchView(match) });
    }
    assertRevision(match, req);
    if (match.status !== 'live') throw new ScoringError('Only a live match can be scored', 409);

    const innings = currentInningsDocument(match);
    const replays = replayAll(match, true);
    const replay = replays[Number(match.currentInningsIndex || 0)];
    if (replay.terminal || innings.status === 'completed') {
      throw new ScoringError('This innings is complete', 409);
    }
    if (!replay.state.strikerId || !replay.state.nonStrikerId || !replay.state.bowlerId) {
      throw new ScoringError('Set the striker, non-striker, and bowler before recording a ball');
    }

    const normalized = normalizeDeliveryInput(req.body);
    if (normalized.wicket && !normalized.wicket.dismissedBatterId) {
      normalized.wicket.dismissedBatterId = replay.state.strikerId;
    }
    if (normalized.wicket) normalized.wicket.dismissedBatterName = '';
    innings.deliveries.push({
      ...normalized,
      clientRequestId,
      sequence: innings.nextSequence,
      createdAt: new Date()
    });
    innings.nextSequence += 1;
    setAutomaticCompletion(match);

    try {
      await match.save();
    } catch (error) {
      if (error?.name !== 'VersionError') throw error;
      const latest = await findHydratedMatchById(req.params.id);
      const savedDuplicate = latest?.innings.some((entry) => entry.deliveries
        .some((delivery) => delivery.clientRequestId === clientRequestId));
      if (!savedDuplicate) throw error;
      return res.json({
        message: 'Delivery already recorded',
        deduplicated: true,
        match: deriveMatchView(latest)
      });
    }
    res.status(201).json({ message: 'Delivery recorded', match: deriveMatchView(match) });
  }));

  app.patch('/api/matches/:id/deliveries/:deliveryId', authRoute(async (req, res) => {
    const match = await findHydratedMatchById(req.params.id);
    if (!match) throw new ScoringError('Match not found', 404);
    assertRevision(match, req);
    const found = findDelivery(match, req.params.deliveryId);
    if (!found) throw new ScoringError('Delivery not found in this match', 404);
    const delivery = found.innings.deliveries[found.deliveryIndex];
    const normalized = normalizeDeliveryInput({
      ...plain(delivery),
      ...req.body,
      extras: req.body.extras === undefined ? plain(delivery.extras) : req.body.extras,
      wicket: req.body.wicket === undefined ? plain(delivery.wicket) : req.body.wicket
    });
    delivery.runsOffBat = normalized.runsOffBat;
    delivery.extras = normalized.extras;
    delivery.runningRuns = normalized.runningRuns;
    delivery.totalRuns = normalized.totalRuns;
    delivery.isLegal = normalized.isLegal;
    delivery.wicket = normalized.wicket || undefined;
    delivery.note = normalized.note;
    delivery.editedAt = new Date();
    delivery.editCount = Number(delivery.editCount || 0) + 1;
    markAutoStateAfterCorrection(match);
    await match.save();
    res.json({ message: 'Delivery corrected', match: deriveMatchView(match) });
  }));

  app.delete('/api/matches/:id/deliveries/last', authRoute(async (req, res) => {
    const match = await findHydratedMatchById(req.params.id);
    if (!match) throw new ScoringError('Match not found', 404);
    assertRevision(match, req);
    const innings = currentInningsDocument(match);
    const removed = innings.deliveries.pop();
    if (!removed) throw new ScoringError('There is no delivery to undo', 409);
    innings.lineupEvents = innings.lineupEvents.filter(
      (event) => Number(event.afterSequence || 0) < Number(removed.sequence)
    );
    markAutoStateAfterCorrection(match);
    await match.save();
    res.json({
      message: 'Last delivery undone',
      removedDeliveryId: removed._id,
      match: deriveMatchView(match)
    });
  }));

  app.post('/api/matches/:id/next-innings', authRoute(async (req, res) => {
    const match = await findHydratedMatchById(req.params.id);
    if (!match) throw new ScoringError('Match not found', 404);
    assertRevision(match, req);
    if (match.status !== 'live') throw new ScoringError('This match is not live', 409);
    if (match.innings.length !== 1) throw new ScoringError('Second innings has already started', 409);
    const first = match.innings[0];
    if (!first.deliveries.length) throw new ScoringError('Record at least one delivery before starting the chase');
    const firstReplay = replayInnings(match, first, { strict: true });
    if (!firstReplay.terminal) {
      throw new ScoringError('Finish the first innings before starting the second innings', 409);
    }
    first.status = 'completed';
    first.completedAt = new Date();
    const battingTeam = getTeamSnapshot(match, first.bowlingTeamId);
    const bowlingTeam = getTeamSnapshot(match, first.battingTeamId);
    match.innings.push(inningsForTeams(2, battingTeam, bowlingTeam));
    match.currentInningsIndex = 1;
    if (req.body.strikerId || req.body.nonStrikerId || req.body.bowlerId) {
      appendLineupEvent(match, match.innings[1], req.body);
    }
    await match.save();
    res.json({ message: 'Second innings started', match: deriveMatchView(match) });
  }));

  app.post('/api/matches/:id/complete', authRoute(async (req, res) => {
    const match = await findHydratedMatchById(req.params.id);
    if (!match) throw new ScoringError('Match not found', 404);
    assertRevision(match, req);
    if (match.status !== 'awaiting_awards') {
      throw new ScoringError('Finish the second innings before completing the match', 409);
    }
    if (match.innings.length !== 2) {
      throw new ScoringError('Both innings must be played before completing the match', 409);
    }
    if (!req.body.manOfMatchPlayerId || !req.body.bestBowlerPlayerId) {
      throw new ScoringError('Select both man of the match and best bowler');
    }
    const replays = replayAll(match, true);
    if (!replays[1]?.terminal) {
      throw new ScoringError('Finish the second innings before completing the match', 409);
    }
    const innings = currentInningsDocument(match);
    innings.status = 'completed';
    innings.completedAt = innings.completedAt || new Date();
    match.status = 'completed';
    match.completionReason = 'manual';
    match.completedAt = new Date();
    refreshStoredResultAndAwards(match, req.body);
    await match.save();
    res.json({ message: 'Match completed', match: deriveMatchView(match) });
  }));

  return { CricketMatch };
}

module.exports = {
  ScoringError,
  assertBowlerWithinLimit,
  attachResolvedTeams,
  bowlerLegalBalls,
  maximumBowlerLegalBalls,
  buildMatchListSnapshot,
  buildReferenceMatchListSnapshot,
  buildInningsScorecard,
  buildResult,
  computePostDeliveryState,
  createSchemas,
  deriveCachedMatchListView,
  deriveAutomaticAwards,
  deriveMatchView,
  hashScorerPassword,
  hydrateMatchReferences,
  issueScorerToken,
  markAutoStateAfterCorrection,
  normalizeDeliveryInput,
  oversFromBalls,
  registerScoringRoutes,
  replayInnings,
  verifyScorerPassword,
  verifyScorerToken
};
