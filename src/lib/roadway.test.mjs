import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoad } from './roadway.ts';

const fix = { latitude: 36.17, longitude: -86.87, accuracy: 6, heading: null, speed: null, timestamp: 0 };
function route(county, y, from, to, direction = 'P') {
  return {
    attributes: { ROUTE_ID: `${county}S015501${direction}00000`, ROUTE_TYPE: 'S', ROUTE_NUMBER: '0155', COUNTY_NUMBER: county },
    geometry: { paths: [[[-86.871, y, from], [-86.869, y, to]]] },
  };
}

test('interpolates TDOT measures and treats opposing carriageways as the same roadway', () => {
  const result = matchRoad(fix, [route('19', 36.17, 25.9, 26.1), route('19', 36.17002, 25.9, 26.1, 'N')]);
  assert.equal(result.kind, 'matched');
  if (result.kind === 'matched') {
    assert.equal(result.match.mile, 26);
    assert.equal(result.match.county, 'Davidson County');
  }
});

test('offers separate candidates where county log miles reset', () => {
  const result = matchRoad(fix, [route('19', 36.17, 25.9, 26.1), route('83', 36.17002, 0, 0.2)]);
  assert.equal(result.kind, 'review');
  if (result.kind === 'review') assert.deepEqual(result.candidates?.map(candidate => candidate.mile), [26, 0.1]);
});

test('withholds estimates for poor fixes or distant roads', () => {
  assert.equal(matchRoad({ ...fix, accuracy: 60 }, [route('19', 36.17, 25.9, 26.1)]).kind, 'review');
  assert.equal(matchRoad(fix, [route('19', 36.18, 25.9, 26.1)]).kind, 'review');
});
