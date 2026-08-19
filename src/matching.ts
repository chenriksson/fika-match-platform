export type Member = {
  id: string;
  email: string;
  name: string;
  optedOut: boolean;
};

export type Match = {
  participantIds: string[];
};

export type MatchConfig = {
  groupSize: 2 | 3 | 4;
  resetThresholdPercent: number;
};

export type MatchResult = {
  matches: Match[];
  resetPerformed: boolean;
  exhaustedMemberPercent: number;
  activeMemberCount: number;
};

export function pairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join(':');
}

function allPairs(memberIds: string[]): string[][] {
  const pairs: string[][] = [];
  for (let left = 0; left < memberIds.length; left += 1) {
    for (let right = left + 1; right < memberIds.length; right += 1) {
      pairs.push([memberIds[left], memberIds[right]]);
    }
  }
  return pairs;
}

function hasFreshConnection(candidateIds: string[], history: Set<string>): boolean {
  for (let left = 0; left < candidateIds.length; left += 1) {
    for (let right = left + 1; right < candidateIds.length; right += 1) {
      if (history.has(pairKey(candidateIds[left], candidateIds[right]))) return false;
    }
  }
  return true;
}

function buildMatches(memberIds: string[], history: Set<string>, groupSize: number): Match[] {
  const remaining = [...memberIds];
  const matches: Match[] = [];
  while (remaining.length >= 2) {
    let selected: string[] | undefined;
    const targetSize = Math.min(groupSize, remaining.length);
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining.slice(index, index + targetSize);
      if (candidate.length >= 2 && hasFreshConnection(candidate, history)) {
        selected = candidate;
        break;
      }
    }
    if (!selected) {
      selected = remaining.slice(0, Math.min(targetSize, remaining.length));
      if (selected.length < 2) break;
    }
    matches.push({ participantIds: selected });
    selected.forEach((id) => remaining.splice(remaining.indexOf(id), 1));
  }
  return matches;
}

function exhaustedMemberPercent(memberIds: string[], history: Set<string>): number {
  if (memberIds.length === 0) return 100;
  const exhausted = memberIds.filter((memberId) => {
    return memberIds.every((otherId) => memberId === otherId || history.has(pairKey(memberId, otherId)));
  }).length;
  return (exhausted / memberIds.length) * 100;
}

export function generateMatches(members: Member[], history: Set<string>, config: MatchConfig): MatchResult {
  const activeMembers = members.filter((member) => !member.optedOut);
  const activeIds = activeMembers.map((member) => member.id);
  const threshold = Math.max(0, Math.min(100, config.resetThresholdPercent));
  const shouldReset = activeIds.length > 1 && exhaustedMemberPercent(activeIds, history) >= threshold;
  if (shouldReset) history.clear();

  const matches = buildMatches(activeIds, history, config.groupSize);
  matches.forEach((match) => {
    allPairs(match.participantIds).forEach(([leftId, rightId]) => history.add(pairKey(leftId, rightId)));
  });

  return {
    matches,
    resetPerformed: shouldReset,
    exhaustedMemberPercent: exhaustedMemberPercent(activeIds, history),
    activeMemberCount: activeIds.length
  };
}
