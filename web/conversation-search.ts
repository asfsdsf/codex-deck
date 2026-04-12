export interface ConversationSearchMatch {
  startFragmentIndex: number;
  startOffset: number;
  endFragmentIndex: number;
  endOffset: number;
}

export function normalizeConversationSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function buildFragmentOffsets(fragments: readonly string[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;

  for (const fragment of fragments) {
    offsets.push(cursor);
    cursor += fragment.length;
  }

  return offsets;
}

function resolveFragmentPosition(
  fragmentOffsets: readonly number[],
  fragments: readonly string[],
  absoluteOffset: number,
): {
  fragmentIndex: number;
  fragmentOffset: number;
} {
  for (
    let fragmentIndex = 0;
    fragmentIndex < fragments.length;
    fragmentIndex++
  ) {
    const fragmentStart = fragmentOffsets[fragmentIndex];
    const fragmentEnd = fragmentStart + fragments[fragmentIndex].length;
    const isLastFragment = fragmentIndex === fragments.length - 1;

    if (
      absoluteOffset < fragmentEnd ||
      (isLastFragment && absoluteOffset === fragmentEnd)
    ) {
      return {
        fragmentIndex,
        fragmentOffset: absoluteOffset - fragmentStart,
      };
    }
  }

  const lastFragmentIndex = Math.max(fragments.length - 1, 0);
  return {
    fragmentIndex: lastFragmentIndex,
    fragmentOffset: fragments[lastFragmentIndex]?.length ?? 0,
  };
}

export function findConversationSearchMatches(
  fragments: readonly string[],
  query: string,
): ConversationSearchMatch[] {
  if (fragments.length === 0) {
    return [];
  }

  const normalizedQuery = normalizeConversationSearchQuery(query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const haystack = fragments.join("").toLocaleLowerCase();
  if (haystack.length === 0) {
    return [];
  }

  const fragmentOffsets = buildFragmentOffsets(fragments);
  const matches: ConversationSearchMatch[] = [];
  let searchStart = 0;

  while (searchStart < haystack.length) {
    const matchStart = haystack.indexOf(normalizedQuery, searchStart);
    if (matchStart === -1) {
      break;
    }

    const matchEnd = matchStart + normalizedQuery.length;
    const start = resolveFragmentPosition(
      fragmentOffsets,
      fragments,
      matchStart,
    );
    const end = resolveFragmentPosition(fragmentOffsets, fragments, matchEnd);

    matches.push({
      startFragmentIndex: start.fragmentIndex,
      startOffset: start.fragmentOffset,
      endFragmentIndex: end.fragmentIndex,
      endOffset: end.fragmentOffset,
    });

    searchStart = matchEnd;
  }

  return matches;
}
