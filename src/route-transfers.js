const railStations = ['새크라멘토', '오마하'];
const railExits = [
  ['tacoma', '타코마'],
  ['southeast', '북미 대륙 남동쪽 연안'],
  ['east', '북미 대륙 동쪽 연안'],
].flatMap(([option, destination]) => railStations.map(station => ({
  option, mode: '철도', names: [station, destination], oneWay: true,
})));

const lines = [
  {option: 'rail', mode: '철도', names: ['샌프란시스코', '새크라멘토', '오마하', '보스턴']},
  ...railExits,
  {option: 'canalCart', mode: '운하', names: ['파나마', '포르토벨로']},
  {option: 'canalCart', mode: '운하', names: ['카이로', '수에즈']},
  {option: 'canalCart', mode: '마차', names: ['칼레', '파리', '마르세이유']},
  {option: 'canalCart', mode: '마차', names: ['피사', '피렌체', '베네치아']},
  {option: 'camel', mode: '낙타', names: ['수에즈', '바스라']},
];

export function createTransfers(places, options) {
  const stops = new Map();
  const edges = [];
  if (!options.automatic) return {stops: [], edges};
  const enabled = {
    rail: options.rail,
    tacoma: options.rail && options.tacoma,
    southeast: options.rail && options.southeast,
    east: options.rail && options.east,
    canalCart: options.canalCart,
    camel: options.canalCart && options.camel,
  };
  for (const {option, mode, names, oneWay} of lines) {
    if (!enabled[option]) continue;
    for (const name of names) {
      const place = places.get(name);
      if (!place?.coord) throw new Error(`Missing coordinates for transfer stop ${name}`);
      stops.set(name, {name, point: place.coord, coastal: ['port', 'landing'].includes(place.navigationType)});
    }
    for (let i = 1; i < names.length; i++) {
      const from = names[i - 1];
      const to = names[i];
      edges.push({from, to, mode});
      if (!oneWay) edges.push({from: to, to: from, mode});
    }
  }
  return {stops: [...stops.values()], edges};
}
