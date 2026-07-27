const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  assertBowlerWithinLimit,
  attachResolvedTeams,
  buildMatchListSnapshot,
  buildReferenceMatchListSnapshot,
  buildInningsScorecard,
  buildResult,
  computePostDeliveryState,
  createSchemas,
  deriveCachedMatchListView,
  deriveMatchView,
  hashScorerPassword,
  hydrateMatchReferences,
  issueScorerToken,
  markAutoStateAfterCorrection,
  normalizeDeliveryInput,
  oversFromBalls,
  replayInnings,
  verifyScorerPassword,
  verifyScorerToken
} = require('./scoring');

const players = {
  a1: { playerId: 'a1', name: 'A One' },
  a2: { playerId: 'a2', name: 'A Two' },
  a3: { playerId: 'a3', name: 'A Three' },
  b1: { playerId: 'b1', name: 'B One' },
  b2: { playerId: 'b2', name: 'B Two' },
  b3: { playerId: 'b3', name: 'B Three' }
};

function matchFixture(oversPerInnings = 2) {
  return {
    _id: 'match-1',
    status: 'live',
    oversPerInnings,
    maxWickets: 2,
    teamA: {
      teamId: 'team-a',
      name: 'Team A',
      players: [players.a1, players.a2, players.a3]
    },
    teamB: {
      teamId: 'team-b',
      name: 'Team B',
      players: [players.b1, players.b2, players.b3]
    },
    innings: []
  };
}

function inningsFixture(number = 1, battingTeamId = 'team-a', deliveries = []) {
  const bowlingTeamId = battingTeamId === 'team-a' ? 'team-b' : 'team-a';
  const battingPrefix = battingTeamId === 'team-a' ? 'a' : 'b';
  const bowlingPrefix = battingTeamId === 'team-a' ? 'b' : 'a';
  return {
    number,
    status: 'live',
    battingTeamId,
    battingTeamName: battingTeamId === 'team-a' ? 'Team A' : 'Team B',
    bowlingTeamId,
    bowlingTeamName: bowlingTeamId === 'team-a' ? 'Team A' : 'Team B',
    lineupEvents: [{
      afterSequence: 0,
      strikerId: `${battingPrefix}1`,
      nonStrikerId: `${battingPrefix}2`,
      bowlerId: `${bowlingPrefix}1`
    }],
    deliveries
  };
}

function ball(sequence, input = {}) {
  return {
    clientRequestId: `request-${sequence}`,
    sequence,
    ...normalizeDeliveryInput(input)
  };
}

test('delivery normalization handles dots, wides, no-balls, and byes', () => {
  const dot = normalizeDeliveryInput({ runsOffBat: 0 });
  assert.equal(dot.totalRuns, 0);
  assert.equal(dot.isLegal, true);

  const wide = normalizeDeliveryInput({ extras: { wide: 3 } });
  assert.equal(wide.totalRuns, 3);
  assert.equal(wide.runningRuns, 2);
  assert.equal(wide.isLegal, false);

  const noBallBoundary = normalizeDeliveryInput({ runsOffBat: 4, extras: { noBall: 1 } });
  assert.equal(noBallBoundary.totalRuns, 5);
  assert.equal(noBallBoundary.runningRuns, 4);
  assert.equal(noBallBoundary.isLegal, false);

  const byes = normalizeDeliveryInput({ extras: { bye: 3 } });
  assert.equal(byes.totalRuns, 3);
  assert.equal(byes.runningRuns, 3);
  assert.equal(byes.isLegal, true);
});

test('invalid extra combinations and no-ball dismissals are rejected', () => {
  assert.throws(
    () => normalizeDeliveryInput({ extras: { wide: 1, noBall: 1 } }),
    /both a wide and a no-ball/
  );
  assert.throws(
    () => normalizeDeliveryInput({ runsOffBat: 1, extras: { bye: 1 } }),
    /cannot be combined/
  );
  assert.throws(
    () => normalizeDeliveryInput({
      extras: { noBall: 1 },
      wicket: { kind: 'caught', dismissedBatterId: 'a1' }
    }),
    /not a valid dismissal from a no-ball/
  );
  assert.equal(
    normalizeDeliveryInput({
      wicket: { kind: 'run out', dismissedBatterId: 'a1', creditedToBowler: true }
    }).wicket.creditedToBowler,
    false
  );
});

test('strike changes on odd runs, stays on even runs, and swaps again at over end', () => {
  const initial = { strikerId: 'a1', nonStrikerId: 'a2', bowlerId: 'b1' };
  const afterOne = computePostDeliveryState(initial, normalizeDeliveryInput({ runsOffBat: 1 }), 0);
  assert.equal(afterOne.strikerId, 'a2');
  assert.equal(afterOne.nonStrikerId, 'a1');

  const afterFour = computePostDeliveryState(initial, normalizeDeliveryInput({ runsOffBat: 4 }), 0);
  assert.equal(afterFour.strikerId, 'a1');
  assert.equal(afterFour.nonStrikerId, 'a2');

  const finalBallOne = computePostDeliveryState(initial, normalizeDeliveryInput({ runsOffBat: 1 }), 5);
  assert.equal(finalBallOne.overCompleted, true);
  assert.equal(finalBallOne.strikerId, 'a1');
  assert.equal(finalBallOne.nonStrikerId, 'a2');
  assert.equal(finalBallOne.bowlerId, null);
});

test('replay counts legal balls and attributes batting and bowling figures correctly', () => {
  const match = matchFixture();
  const innings = inningsFixture(1, 'team-a', [
    ball(1),
    ball(2, { runsOffBat: 1 }),
    ball(3, { extras: { wide: 1 } }),
    ball(4, { runsOffBat: 4, extras: { noBall: 1 } }),
    ball(5, { extras: { bye: 3 } })
  ]);
  match.innings = [innings];
  const replay = replayInnings(match, innings);
  const scorecard = buildInningsScorecard(match, innings, replay);

  assert.equal(replay.totalRuns, 10);
  assert.equal(replay.legalBalls, 3);
  assert.equal(replay.overs, '0.3');
  assert.equal(scorecard.extras.wide, 1);
  assert.equal(scorecard.extras.noBall, 1);
  assert.equal(scorecard.extras.bye, 3);
  assert.equal(scorecard.bowlingScorecard[0].runs, 7);
  assert.equal(scorecard.bowlingScorecard[0].balls, 3);
  assert.equal(scorecard.battingScorecard.reduce((sum, entry) => sum + entry.balls, 0), 3);
});

test('caught and stumped dismissals are attributed to the bowler', () => {
  const match = matchFixture();
  const innings = inningsFixture(1, 'team-a', [
    ball(1, { wicket: { kind: 'caught', dismissedBatterId: 'a1' } })
  ]);
  match.innings = [innings];
  let replay = replayInnings(match, innings);
  let scorecard = buildInningsScorecard(match, innings, replay);
  assert.equal(replay.wickets, 1);
  assert.equal(replay.legalBalls, 1);
  assert.equal(scorecard.bowlingScorecard[0].wickets, 1);

  const wideStumping = inningsFixture(1, 'team-a', [
    ball(1, {
      extras: { wide: 1 },
      wicket: { kind: 'stumped', dismissedBatterId: 'a1' }
    })
  ]);
  match.innings = [wideStumping];
  replay = replayInnings(match, wideStumping);
  scorecard = buildInningsScorecard(match, wideStumping, replay);
  assert.equal(replay.wickets, 1);
  assert.equal(replay.legalBalls, 0);
  assert.equal(scorecard.bowlingScorecard[0].wickets, 1);
  assert.equal(scorecard.bowlingScorecard[0].wides, 1);
});

test('editing an early delivery replays later striker attribution', () => {
  const match = matchFixture();
  const innings = inningsFixture(1, 'team-a', [
    ball(1, { runsOffBat: 1 }),
    ball(2, { runsOffBat: 2 })
  ]);
  match.innings = [innings];
  const beforeEdit = replayInnings(match, innings);
  assert.equal(beforeEdit.deliveries[1].strikerId, 'a2');

  innings.deliveries[0] = ball(1, { runsOffBat: 0 });
  const afterEdit = replayInnings(match, innings);
  assert.equal(afterEdit.deliveries[1].strikerId, 'a1');
  assert.equal(afterEdit.totalRuns, 2);
  assert.equal(afterEdit.legalBalls, 2);
});

test('a chase can finish on a wide and a completed level chase is a tie', () => {
  const match = matchFixture(1);
  const first = inningsFixture(1, 'team-a', [ball(1)]);
  const second = inningsFixture(2, 'team-b', [ball(1, { extras: { wide: 1 } })]);
  match.innings = [first, second];
  const firstReplay = replayInnings(match, first);
  const secondReplay = replayInnings(match, second, { target: firstReplay.totalRuns + 1 });
  assert.equal(secondReplay.terminal, true);
  assert.equal(secondReplay.terminalReason, 'target-reached');

  const firstWithRun = inningsFixture(1, 'team-a', [ball(1, { runsOffBat: 1 })]);
  const sixDots = Array.from({ length: 6 }, (_, index) => ball(index + 1));
  const levelSecond = inningsFixture(2, 'team-b', [
    ...sixDots.slice(0, 5),
    ball(6, { runsOffBat: 1 })
  ]);
  match.innings = [firstWithRun, levelSecond];
  const firstView = buildInningsScorecard(
    match,
    firstWithRun,
    replayInnings(match, firstWithRun)
  );
  const secondView = buildInningsScorecard(
    match,
    levelSecond,
    replayInnings(match, levelSecond, { target: 2 })
  );
  const result = buildResult(match, [firstView, secondView]);
  assert.equal(secondView.terminalReason, 'overs-complete');
  assert.equal(result.tie, true);
  assert.equal(result.text, 'Match tied');
});

test('overs use legal-ball integers', () => {
  assert.equal(oversFromBalls(0), '0.0');
  assert.equal(oversFromBalls(5), '0.5');
  assert.equal(oversFromBalls(6), '1.0');
  assert.equal(oversFromBalls(17), '2.5');
});

test('bowler over limits count legal balls and reject an exhausted bowler', () => {
  const replay = {
    deliveries: [
      ...Array.from({ length: 18 }, () => ({ bowlerId: 'b1', isLegal: true })),
      ...Array.from({ length: 5 }, () => ({ bowlerId: 'b2', isLegal: true })),
      { bowlerId: 'b2', isLegal: false }
    ]
  };

  assert.throws(
    () => assertBowlerWithinLimit({ maxOversPerBowler: 3 }, replay, 'b1'),
    /maximum 3 overs allowed/
  );
  assert.doesNotThrow(
    () => assertBowlerWithinLimit({ maxOversPerBowler: 3 }, replay, 'b2')
  );
  assert.doesNotThrow(
    () => assertBowlerWithinLimit({ maxOversPerBowler: 0 }, replay, 'b1')
  );
});

test('public match view exposes live scoring aliases without internal scorer metadata', () => {
  const match = matchFixture();
  match.revision = 4;
  const delivery = ball(1, { runsOffBat: 1, note: 'Saved note' });
  delivery._id = 'delivery-1';
  delivery.clientRequestId = 'private-idempotency-key';
  delivery.editedAt = new Date();
  delivery.editCount = 2;
  const innings = inningsFixture(1, 'team-a', [delivery]);
  innings.nextSequence = 2;
  match.innings = [innings];
  match.currentInningsIndex = 0;

  const view = deriveMatchView(match);
  assert.equal(view.currentInnings.totalRuns, 1);
  assert.equal(view.currentInnings.strikerId, 'a2');
  assert.equal(view.currentInnings.needsBatter, false);
  assert.equal(view.currentInnings.needsBowler, false);
  assert.equal(view.currentInnings.deliveries.length, 1);
  assert.equal(view.currentInnings.deliveries[0].overLabel, '0.1');
  assert.equal(view.currentInnings.deliveries[0].clientRequestId, undefined);
  assert.equal(view.currentInnings.deliveries[0].editedAt, undefined);
  assert.equal(view.innings[0].lineupEvents, undefined);
  assert.equal(view.innings[0].nextSequence, undefined);
  assert.equal(view.revision, 4);

  const summary = deriveMatchView(match, { detail: false });
  assert.equal(summary.teamA.players, undefined);
  assert.equal(summary.currentInnings.deliveries, undefined);
  assert.equal(summary.innings, undefined);
});

test('correcting a completed chase below the target reopens the match', () => {
  const match = matchFixture(1);
  const first = inningsFixture(
    1,
    'team-a',
    Array.from({ length: 6 }, (_, index) => ball(index + 1))
  );
  first.status = 'completed';
  const second = inningsFixture(2, 'team-b', [ball(1, { runsOffBat: 1 })]);
  second.status = 'completed';
  match.innings = [first, second];
  match.currentInningsIndex = 1;
  match.status = 'completed';
  match.completionReason = 'manual';
  match.result = { text: 'Team B won' };
  match.awards = {
    manOfMatch: { playerId: 'b1', name: 'B One' },
    bestBowler: { playerId: 'a1', name: 'A One' }
  };

  second.deliveries[0] = ball(1);
  markAutoStateAfterCorrection(match);

  assert.equal(match.status, 'live');
  assert.equal(match.completionReason, '');
  assert.equal(match.result, null);
  assert.equal(match.awards.manOfMatch, null);
  assert.equal(match.innings[1].status, 'live');
});

test('cached match list snapshots do not need embedded delivery histories', () => {
  const match = matchFixture();
  match.revision = 7;
  match.innings = [inningsFixture(1, 'team-a', [ball(1, { runsOffBat: 4 })])];
  match.currentInningsIndex = 0;
  const listSnapshot = buildMatchListSnapshot(match);
  const projected = {
    ...match,
    innings: undefined,
    teamA: { teamId: match.teamA.teamId, name: match.teamA.name },
    teamB: { teamId: match.teamB.teamId, name: match.teamB.name },
    listSnapshot
  };

  const view = deriveCachedMatchListView(projected);
  assert.equal(view.currentInnings.totalRuns, 4);
  assert.equal(view.inningsSummaries[0].overs, '0.1');
  assert.equal(view.teamA.players, undefined);
  assert.equal(view.currentInnings.deliveries, undefined);
  assert.equal(view.revision, 7);
});

test('correcting the terminal ball reopens the current first innings', () => {
  const match = matchFixture(1);
  const first = inningsFixture(
    1,
    'team-a',
    Array.from({ length: 6 }, (_, index) => ball(index + 1))
  );
  first.status = 'completed';
  first.completedAt = new Date();
  match.innings = [first];
  match.currentInningsIndex = 0;
  match.status = 'live';

  first.deliveries[5] = ball(6, { extras: { wide: 1 } });
  markAutoStateAfterCorrection(match);

  assert.equal(match.status, 'live');
  assert.equal(match.innings[0].status, 'live');
  assert.equal(match.innings[0].completedAt, null);
});

test('a historical correction cannot invalidate the first innings after the chase starts', () => {
  const match = matchFixture(1);
  const first = inningsFixture(
    1,
    'team-a',
    Array.from({ length: 6 }, (_, index) => ball(index + 1))
  );
  first.status = 'completed';
  const second = inningsFixture(2, 'team-b', [ball(1, { runsOffBat: 1 })]);
  match.innings = [first, second];
  match.currentInningsIndex = 1;
  match.status = 'completed';
  match.completionReason = 'manual';

  first.deliveries[5] = ball(6, { extras: { wide: 1 } });

  assert.throws(
    () => markAutoStateAfterCorrection(match),
    /first innings unfinished/
  );
});

test('new match schema stores Team and Player references without embedded snapshots', () => {
  const schema = createSchemas(mongoose);
  const Model = mongoose.models.ScoringReferenceTest
    || mongoose.model('ScoringReferenceTest', schema);
  const teamAId = new mongoose.Types.ObjectId();
  const teamBId = new mongoose.Types.ObjectId();
  const teamAPlayerIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const teamBPlayerIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const match = new Model({
    teamAId,
    teamBId,
    teamAPlayerIds,
    teamBPlayerIds,
    oversPerInnings: 2,
    maxWickets: 1
  });

  assert.equal(match.validateSync(), undefined);
  const stored = match.toObject();
  assert.equal(String(stored.teamAId), String(teamAId));
  assert.equal(String(stored.teamBId), String(teamBId));
  assert.deepEqual(stored.teamAPlayerIds.map(String), teamAPlayerIds.map(String));
  assert.deepEqual(stored.teamBPlayerIds.map(String), teamBPlayerIds.map(String));
  assert.equal(stored.teamA, undefined);
  assert.equal(stored.teamB, undefined);
});

test('reference hydration reflects current Team and Player data and preserves frozen live rosters', async () => {
  const match = {
    _id: 'reference-match',
    status: 'live',
    teamAId: 'team-a',
    teamBId: 'team-b',
    teamAPlayerIds: ['a1', 'a2'],
    teamBPlayerIds: ['b1', 'b2'],
    innings: []
  };
  const teams = [
    { _id: 'team-a', name: 'Renamed A', logo: 'a.png' },
    { _id: 'team-b', name: 'Renamed B', logo: 'b.png' }
  ];
  const currentPlayers = [
    { _id: 'a1', name: 'Updated A One', teamId: 'team-b', sold: false },
    { _id: 'a2', name: 'A Two', teamId: null, sold: false },
    { _id: 'b1', name: 'B One', teamId: 'team-b', sold: true },
    { _id: 'b2', name: 'B Two', teamId: 'team-b', sold: true }
  ];
  const query = (value) => ({
    select() { return this; },
    sort() { return this; },
    lean: async () => value
  });

  await hydrateMatchReferences(match, {
    Team: { find: () => query(teams) },
    Player: { find: () => query(currentPlayers) }
  });
  const resolvedA = match._resolvedTeams[0];
  assert.equal(resolvedA.name, 'Renamed A');
  assert.deepEqual(resolvedA.players.map((player) => player.name), ['Updated A One', 'A Two']);
  assert.equal(match.teamA, undefined);
  assert.equal(match.teamB, undefined);
});

test('reference hydration handles Mongoose ObjectId values without recursion', async () => {
  const teamAId = new mongoose.Types.ObjectId();
  const teamBId = new mongoose.Types.ObjectId();
  const playerAId = new mongoose.Types.ObjectId();
  const playerBId = new mongoose.Types.ObjectId();
  const match = {
    _id: new mongoose.Types.ObjectId(),
    status: 'live',
    teamAId,
    teamBId,
    teamAPlayerIds: [playerAId],
    teamBPlayerIds: [playerBId],
    innings: []
  };
  const query = (value) => ({
    select() { return this; },
    sort() { return this; },
    lean: async () => value
  });

  await hydrateMatchReferences(match, {
    Team: {
      find: () => query([
        { _id: teamAId, name: 'ObjectId Team A' },
        { _id: teamBId, name: 'ObjectId Team B' }
      ])
    },
    Player: {
      find: () => query([
        { _id: playerAId, name: 'ObjectId Player A', teamId: teamAId, sold: true },
        { _id: playerBId, name: 'ObjectId Player B', teamId: teamBId, sold: true }
      ])
    }
  });

  assert.equal(match._resolvedTeams[0].name, 'ObjectId Team A');
  assert.equal(match._resolvedTeams[0].players[0].name, 'ObjectId Player A');
});

test('compact normalized list snapshots contain IDs and scores but no copied master names', () => {
  const legacy = matchFixture();
  const normalized = {
    ...legacy,
    teamAId: legacy.teamA.teamId,
    teamBId: legacy.teamB.teamId,
    teamAPlayerIds: legacy.teamA.players.map((player) => player.playerId),
    teamBPlayerIds: legacy.teamB.players.map((player) => player.playerId),
    teamA: undefined,
    teamB: undefined,
    innings: [inningsFixture(1, 'team-a', [ball(1, { runsOffBat: 4 })])]
  };
  attachResolvedTeams(normalized, [legacy.teamA, legacy.teamB]);
  const snapshot = buildReferenceMatchListSnapshot(normalized);
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.storage, 'references-v1');
  assert.equal(snapshot.currentInnings.totalRuns, 4);
  assert.equal(serialized.includes('Team A'), false);
  assert.equal(serialized.includes('A One'), false);

  normalized.listSnapshot = snapshot;
  normalized.innings = undefined;
  const view = deriveCachedMatchListView(normalized);
  assert.equal(view.teamA.name, 'Team A');
  assert.equal(view.currentInnings.totalRuns, 4);
});

test('scorer passwords are one-way hashed and token rotation invalidates old sessions', async () => {
  const password = 'correct horse battery staple';
  const storedHash = await hashScorerPassword(password);
  assert.equal(storedHash.includes(password), false);
  assert.equal(await verifyScorerPassword(password, storedHash), true);
  assert.equal(await verifyScorerPassword('wrong password', storedHash), false);

  const credential = { storedHash, fallbackPin: '', configured: true };
  const session = issueScorerToken(credential);
  assert.equal(verifyScorerToken(session.token, credential), true);
  const rotatedHash = await hashScorerPassword('a completely different password');
  assert.equal(
    verifyScorerToken(session.token, { storedHash: rotatedHash, fallbackPin: '', configured: true }),
    false
  );
});
