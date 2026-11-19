import maskUrl from '../../DB/coastline_mask.png?url';
import seas from '../../DB/seas.json';
import {findSeaRoute, markOcean, routeWorld} from './route-search.js';
import {createWindModel, sailingSpeedMultiplier} from './route-wind.js';

let terrain;
const sailingCost = createWindModel(seas, routeWorld.width);

async function loadTerrain() {
  const response = await fetch(maskUrl);
  if (!response.ok) throw new Error('Could not load the coastline mask');
  const image = await createImageBitmap(await response.blob());
  const {width, height} = image;
  const scale = routeWorld.width / width;
  if (scale !== 4 || height * scale !== routeWorld.height) {
    image.close();
    throw new Error('Coastline mask dimensions do not match the world');
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', {willReadFrequently: true});
  context.drawImage(image, 0, 0);
  image.close();
  const pixels = context.getImageData(0, 0, width, height).data;
  const water = sailingCost.seaMask(routeWorld.height, scale);
  for (let i = 0; i < water.length; i++) if (pixels[i * 4] !== 255) water[i] = 0;
  // Central Indian Ocean on the project's fixed world mask.
  markOcean(water, width, height, 1024 * width + 2048);
  return {water, width, height, scale};
}

self.onmessage = async ({data: {departures, arrivals, transfers, objective, season}}) => {
  try {
    terrain ??= await loadTerrain();
    const {water, width, height, scale} = terrain;
    const windModel = objective === 'balanced' ? {
      segment: (a, b, heading) => sailingCost.segment(a, b, heading, season).equivalentDistance,
      factors: point => {
        const speed = sailingCost.speedAt(point.x, point.y, season);
        return Array.from({length: 180}, (_, i) => 1 / sailingSpeedMultiplier(i * 2, speed));
      },
    } : undefined;
    const route = findSeaRoute(water, width, height, scale, departures, arrivals, transfers, objective, windModel);
    if (route) {
      route.wind = {
        summer: sailingCost.sail(route.legs, 'summer'),
        winter: sailingCost.sail(route.legs, 'winter'),
      };
    }
    self.postMessage({route});
  } catch (error) {
    console.error(error);
    self.postMessage({error: true});
  }
};
