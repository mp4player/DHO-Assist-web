// navigator3.html starts the Japanese summer phase at this instant.
const japaneseSummerStart = Date.parse('2005-03-16T13:30:00+09:00');
const seasonDuration = 9 * 60 * 60 * 1000;

export function windSeasonAt(timestamp) {
  const phase = Math.floor((timestamp - japaneseSummerStart) / seasonDuration);
  return {
    season: phase % 2 === 0 ? 'summer' : 'winter',
    nextChange: japaneseSummerStart + (phase + 1) * seasonDuration,
  };
}
