'use strict';

/**
 * Small, dependency-free policy implementation used by the CLI's local
 * regression scenario. Server-side vote evaluation remains authoritative.
 */
class VotingEngine {
  CALC_calculateWinner(votes, censusSize, _evaluationMode = null, options = {}) {
    const method = options.countingMethod || 'majority';
    const totals = new Map();

    if (method === 'ranked_choice') {
      return this._rankedChoice(votes, censusSize);
    }

    for (const ballot of votes) {
      const first = ballot.choices?.[0]?.vote?.choiceId;
      if (first !== undefined) totals.set(first, (totals.get(first) || 0) + 1);
    }

    const winner = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
    const hasWinner = Boolean(winner && winner[1] > censusSize / 2);
    return {
      hasWinner,
      winningOption: hasWinner ? { choiceId: winner[0] } : null
    };
  }

  _rankedChoice(votes, censusSize) {
    const remaining = new Set(votes.flatMap(ballot =>
      ballot.choices.map(choice => choice.vote.choiceId)));

    while (remaining.size > 0) {
      const totals = new Map();
      for (const ballot of votes) {
        const choice = ballot.choices.find(item => remaining.has(item.vote.choiceId));
        if (choice) totals.set(choice.vote.choiceId, (totals.get(choice.vote.choiceId) || 0) + 1);
      }
      const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      if (!ordered.length) break;
      if (ordered[0][1] > censusSize / 2) {
        return { hasWinner: true, winningOption: { choiceId: ordered[0][0] } };
      }
      const lowest = ordered[ordered.length - 1][1];
      for (const [choiceId, count] of ordered) {
        if (count === lowest) remaining.delete(choiceId);
      }
    }

    return { hasWinner: false, winningOption: null };
  }
}

module.exports = VotingEngine;
