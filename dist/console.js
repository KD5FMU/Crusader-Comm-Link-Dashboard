'use strict';

const stations = {
  61001: { call: 'W0DEMO', city: 'Kansas City, MO', coords: [39.10, -94.58] },
  61002: { call: 'N9DEMO', city: 'Chicago, IL', coords: [41.88, -87.63] },
  61003: { call: 'K4DEMO', city: 'Nashville, TN', coords: [36.16, -86.78] },
  61004: { call: 'W5DEMO', city: 'Tulsa, OK', coords: [36.15, -95.99] },
  61005: { call: 'K8DEMO', city: 'Columbus, OH', coords: [39.96, -83.00] },
  61006: { call: 'N0DEMO', city: 'Location unavailable', coords: null }
};
const home = [38.63, -90.20];
const modules = {ticker:'Status ticker', map:'Link map', nodes:'Node Control', linked:'Nodes Linked', weather:'Current conditions', radar:'Weather radar', skywarn:'SkywarnPlus'};
const key = 'crusader-demo-v1';
const palettes = {crusader:'Crusader',forest:'Forest',copper:'Copper',slate:'Slate',violet:'Violet'};
const defaults = {
  theme: 'night',
  palette: 'crusader',
  stationTitle: 'Station overview',
  stationEyebrow: 'HAM RADIO CRUSADER',
  order: Object.keys(modules),
  layoutVersion: 2,
  hidden: [],
  tall: false,
  sizes: {},
  placements: {},
  layoutStyle: "workspace",
  lanes: {},
  stationLocations: {},
  favoritePeers: {},
  linkedDetails: true,
  automaticLocations: true,
  layoutHistory: [],
  layoutPresets: [],
  tickerNodes: true,
  tickerNews: true,
  newsNational: 'abc',
  newsLocal: 'kjrh',
  newsBreaking: 'abc',
  tickerWeather: true,
  tickerAlerts: true,
  tickerSpeed: 'normal',
  tickerDisplay: 'scroll',
  tickerPaused: false,
  linkEvents: [],
  watchPlaces: '',
  skyDetails: true,
  motion: true,
  labels: 'call',
  pulseSpeed: 'normal',
  boundaries: true,
  nodeSort: 'number',
  nodeDetails: true,
  defaultMode: 'Transceive',
  units: 'us',
  weatherDetails: true,
  radarOpacity: 'standard',
  radarLegend: true,
  links: {61001:'Transceive',61002:'Transceive',61003:'Monitor'},
  tx: null
};
const byId = id => document.getElementById(id);
function completeOrder(order) {
  const known = [...new Set(order.filter(id => Object.hasOwn(modules,id)))];
  if (!known.includes('linked') && known.includes('nodes')) known.splice(known.indexOf('nodes') + 1,0,'linked');
  return [...new Set([...known,...defaults.order])];
}
const read = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    const saved = {...defaults, ...stored};
    if (stored && stored.layoutVersion !== 2) saved.order = ['ticker',...saved.order];
    saved.order = completeOrder(saved.order);
    if (!Object.hasOwn(palettes,saved.palette)) saved.palette = defaults.palette;
    return saved;
  }
  catch { return defaults; }
};
let state = read();
const laneDefaults = {ticker:'top',map:'main',nodes:'side',linked:'side',weather:'side',radar:'main',skywarn:'side'};
const layoutPanels = Object.fromEntries([...byId('layout').children].map(panel => [panel.dataset.module,panel]));
const workspaceLanes = Object.fromEntries(['top','main','side'].map(id => {
  const element = document.createElement('div');
  element.className = 'workspace-lane workspace-' + id;
  return [id,element];
}));
function laneOf(id) { return state.lanes[id] ?? laneDefaults[id]; }
const detached = new URLSearchParams(location.search).get('panel');
const liveMode = new URLSearchParams(location.search).get("live") === "1";
let liveSnapshot = {};
let account = null;
const callerOnly = new URLSearchParams(location.search).get("view") === "caller";
const panelOnly = Object.hasOwn(modules, detached);
document.body.classList.toggle('popout', panelOnly);

let linkMap, radarMap, linksLayer, backgroundLayers = [];
let pulseFrame, expiryTimer, path;
let settingsSection = 'station';
const configurationSections = {station:'Station heading',appearance:'Color themes',layout:'Layout',...modules};
const radarCells = [];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const color = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function arrangement({order, hidden, sizes, tall, placements = {}, layoutStyle = "workspace", lanes = {}}) {
  return {order,hidden,sizes,tall,placements,layoutStyle,lanes};
}

function changeLayout(change) {
  const previous = arrangement(state);
  if (JSON.stringify(previous) === JSON.stringify({...previous,...change})) return;
  update({...change,layoutHistory:[...state.layoutHistory.slice(-19),previous]});
}

function undoLayout() {
  const previous = state.layoutHistory.at(-1);
  if (!previous) return;
  update({...arrangement(previous),layoutHistory:state.layoutHistory.slice(0,-1)});
  byId('layoutStatus').textContent = 'Previous layout restored.';
}

function update(change) {
  if (liveMode && account?.role === "Observer") return;
  state = {...read(), ...change};
  state.order = completeOrder(state.order);
  localStorage.setItem(key, JSON.stringify(state));
  render();
}
addEventListener('storage', event => {
  if (event.key === key && (!liveMode || account)) {
    const previousMode = state.defaultMode;
    state = read();
    if (state.defaultMode !== previousMode) byId('mode').value = state.defaultMode;
    render();
    if (!byId('configuration').hidden) renderSettings();
  }
});
reducedMotion.addEventListener('change', () => { if (!liveMode || account) { renderMap(); renderTicker(); } });

function buildMap(id, center, zoom) {
  const map = L.map(id, {zoomControl:false, attributionControl:false, fadeAnimation:id !== "linkMap", minZoom:2, maxZoom:10, preferCanvas:true, maxBounds:[[-85,-179],[85,179]]}).setView(center, zoom);
  L.control.zoom({position:'topright'}).addTo(map);
  L.control.attribution({prefix:false}).addAttribution('Map data © Natural Earth · PublicaMundi').addTo(map);
  return map;
}

async function loadBoundaries() {
  try {
    const datasets = await Promise.all(['countries.json','states.json'].map(async file => {
      const response = await fetch(file);
      if (!response.ok) throw new Error(file);
      return response.json();
    }));
    for (const map of [linkMap, radarMap]) {
      datasets.forEach((data, index) => {
        const layer = L.geoJSON(data, {interactive:false,pane:map === linkMap ? "network-base" : "overlayPane"}).addTo(map).bringToBack();
        backgroundLayers.push({layer, index});
      });
      backgroundLayers.at(-2).layer.bringToBack();
    }
    styleBoundaries();
  } catch {
    for (const map of [linkMap, radarMap]) map.getContainer().setAttribute('aria-description','Basemap unavailable');
  }
}
function styleBoundaries() {
  for (const {layer, index} of backgroundLayers) {
    layer.setStyle({color:color('--coast'), opacity:index && !state.boundaries ? 0 : 1, weight:index ? .65 : 1, fillColor:color('--land'), fillOpacity:index ? 0 : .86});
  }
}
function fitNetwork() {
  const local = stationCoords(liveSnapshot.node);
  const points = liveMode
    ? [local,...(liveSnapshot.links ?? []).map(link => stationCoords(link.node))].filter(Boolean)
    : [home, ...Object.keys(state.links).map(id => stations[id]?.coords).filter(Boolean)];
  if (!points.length) return;
  linkMap.invalidateSize();
  linkMap.fitBounds(points, {padding:[48,48],maxZoom:6,animate:false});
}
function activeTx() {
  if (state.tx?.until > Date.now() && state.links[state.tx.id]) return state.tx;
  return null;
}
let labelFrame;

function intersectsLabel(start, end, box) {
  let enter = 0;
  let exit = 1;
  for (const [axis, min, max] of [['x',box.left,box.right],['y',box.top,box.bottom]]) {
    const delta = end[axis] - start[axis];
    if (delta === 0) {
      if (start[axis] < min || start[axis] > max) return false;
      continue;
    }
    const from = (min - start[axis]) / delta;
    const to = (max - start[axis]) / delta;
    enter = Math.max(enter,Math.min(from,to));
    exit = Math.min(exit,Math.max(from,to));
    if (enter > exit) return false;
  }
  return true;
}

function placeMapLabels() {
  const size = linkMap.getSize();
  const segments = [];
  const labels = [];
  linksLayer.eachLayer(layer => {
    if (layer instanceof L.Polyline) {
      const points = layer.getLatLngs().map(point => linkMap.latLngToContainerPoint(point));
      for (let i = 1; i < points.length; i++) segments.push([points[i-1],points[i]]);
    } else if (layer instanceof L.CircleMarker) {
      const tooltip = layer.getTooltip();
      const element = tooltip?.getElement();
      if (element) labels.push({layer,tooltip,element,point:linkMap.latLngToContainerPoint(layer.getLatLng()),
        halfWidth:element.offsetWidth/2,halfHeight:element.offsetHeight/2});
    }
  });
  labels.sort((a,b) => b.layer.getRadius() - a.layer.getRadius());
  const placed = [];
  const directions = [[0,-1],[0,1],[1,0],[-1,0],[1,-1],[-1,-1],[1,1],[-1,1]];
  for (const {layer,tooltip,element,point,halfWidth,halfHeight} of labels) {
    let position;
    if (point.x >= 0 && point.x <= size.x && point.y >= 0 && point.y <= size.y) {
      for (const extra of [0,14,30]) {
        for (const [dx,dy] of directions) {
          const gap = layer.getRadius() + 6 + extra;
          const x = dx * (halfWidth + gap);
          const y = dy * (halfHeight + gap);
          const box = {left:point.x+x-halfWidth-3,right:point.x+x+halfWidth+3,
            top:point.y+y-halfHeight-3,bottom:point.y+y+halfHeight+3};
          if (box.left < 0 || box.top < 0 || box.right > size.x || box.bottom > size.y) continue;
          if (segments.some(([start,end]) => intersectsLabel(start,end,box))) continue;
          if (placed.some(other => box.left < other.right && box.right > other.left &&
              box.top < other.bottom && box.bottom > other.top)) continue;
          if (labels.some(other => other.layer !== layer &&
              intersectsLabel(other.point,other.point,box))) continue;
          placed.push(box);
          position = L.point(x,y);
          break;
        }
        if (position) break;
      }
    }
    element.style.visibility = position ? 'visible' : 'hidden';
    if (position && !L.point(tooltip.options.offset).equals(position)) {
      tooltip.options.offset = position;
      tooltip.update();
    }
  }
}

function queueMapLabels() {
  if (labelFrame !== undefined) return;
  labelFrame = requestAnimationFrame(() => {
    labelFrame = undefined;
    placeMapLabels();
  });
}

function renderMap() {
  if (!linksLayer) return;
  if (liveMode) { renderLiveMap(); return; }
  cancelAnimationFrame(pulseFrame);
  linksLayer.clearLayers();
  const tx = activeTx();
  const linked = color('--accent');
  const transmitting = color('--tx');
  path = null;
  for (const id of Object.keys(state.links)) {
    const station = stations[id];
    if (!station.coords) continue;
    const active = tx?.id === id;
    const hue = active ? transmitting : linked;
    const line = L.polyline([station.coords, home], {color:hue,opacity:active ? .95 : .52,weight:active ? 3 : 1.5,interactive:false}).addTo(linksLayer);
    if (active) path = line.getLatLngs();
    const marker = L.circleMarker(station.coords,{radius:active ? 7 : 5,color:hue,fillColor:hue,fillOpacity:.78,weight:1})
      .bindPopup(station.call + ' · ' + id + '<br>' + station.city)
      .addTo(linksLayer);
    const label = {call:station.call, number:id, both:station.call + ' · ' + id}[state.labels];
    if (label) marker.bindTooltip(label,{permanent:true,direction:'center',className:'network-label'});
  }
  L.circleMarker(home,{radius:9,color:linked,fillColor:linked,fillOpacity:.22,weight:3})
    .bindTooltip('CONTROL · 61000',{permanent:true,direction:'center',className:'network-label'}).addTo(linksLayer);
  queueMapLabels();
  if (!path || !state.motion || reducedMotion.matches || byId('linkMap').closest('[hidden]')) return;
  animatePulses([path],tx.start,() => Boolean(activeTx()));
}

function animatePulses(paths,startTime,isActive) {
  const hue = color('--tx');
  const dots = paths.map(([source,target]) => ({
    source:L.latLng(source), target:L.latLng(target),
    glow:L.circleMarker(source,{radius:10,stroke:false,fillColor:hue,fillOpacity:.24,interactive:false}).addTo(linksLayer),
    blip:L.circleMarker(source,{radius:4,stroke:false,fillColor:hue,fillOpacity:1,interactive:false}).addTo(linksLayer)
  }));
  const duration = {slow:2200,normal:1350,fast:750}[state.pulseSpeed];
  function move() {
    if (!isActive()) {
      for (const {glow,blip} of dots) { linksLayer.removeLayer(glow); linksLayer.removeLayer(blip); }
      return;
    }
    const fraction = ((Date.now() - startTime) % duration) / duration;
    for (const {source,target,glow,blip} of dots) {
      const start = linkMap.project(source);
      const end = linkMap.project(target);
      const point = linkMap.unproject(start.add(end.subtract(start).multiplyBy(fraction)));
      glow.setLatLng(point);
      blip.setLatLng(point);
    }
    pulseFrame = requestAnimationFrame(move);
  }
  pulseFrame = requestAnimationFrame(move);
}

function transmit(id) {
  if (!state.links[id]) return;
  const start = Date.now();
  update({tx:{id,start,until:start+8100}});
}
function renderLinks(tx) {
  const list = byId('links');
  const existing = document.activeElement?.dataset;
  list.replaceChildren();
  const entries = Object.entries(state.links);
  if (state.nodeSort === 'call') entries.sort(([a],[b]) => stations[a].call.localeCompare(stations[b].call));
  if (state.nodeSort === 'activity' && tx) entries.sort(([a],[b]) => Number(b === tx.id) - Number(a === tx.id));
  for (const [id, mode] of entries) {
    const station = stations[id];
    const row = document.createElement('div');
    row.className = 'link-row' + (tx?.id === id ? ' active' : '');
    const info = document.createElement('div');
    info.className = 'link-info';
    const title = document.createElement('strong');
    title.textContent = station.call + ' · ';
    const number = document.createElement('span');
    number.className = 'linked-node-number';
    number.classList.toggle('link-receiving',tx?.id === id);
    number.textContent = id;
    title.append(number);
    const details = document.createElement('small');
    details.textContent = (state.nodeDetails ? station.city + ' · ' : '') + mode + (tx?.id === id ? ' · Receiving' : '');
    info.append(title,details);
    const actions = document.createElement('div');
    actions.className = 'link-actions';
    const button = document.createElement('button');
    button.textContent = 'Disconnect';
    button.dataset.id = id;
    button.dataset.action = 'Disconnect';
    button.setAttribute('aria-label','Disconnect ' + station.call);
    button.onclick = () => {
      const links = {...state.links};
      delete links[id];
      update({links,tx:state.tx?.id === id ? null : state.tx,linkEvents:recentEvent(station.call + ' · ' + id + ' disconnected')});
      byId('feedback').textContent = 'Disconnected ' + station.call + '.';
      byId('nodeInput').focus();
    };
    actions.append(button);
    row.append(info,actions);
    list.append(row);
  }
  if (existing?.id) list.querySelector('[data-id="' + existing.id + '"][data-action="' + existing.action + '"]')?.focus();
  if (!list.children.length) list.textContent = 'No stations connected.';
  const select = byId('nodeInput');
  const selected = select.value;
  const available = Object.keys(stations).filter(id => !state.links[id]);
  select.replaceChildren(...available.map(id => new Option(id + ' · ' + stations[id].call,id)));
  if (available.includes(selected)) select.value = selected;
  if (!available.length) select.add(new Option('All stations linked',''));
  byId('connect').querySelector('button').disabled = !available.length;
}
function render() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.palette = state.palette;
  byId('theme').textContent = state.theme === 'night' ? '☀ Day mode' : '☾ Night mode';
  styleBoundaries();
  const layout = byId('layout');
  const workspace = !panelOnly && state.layoutStyle === 'workspace';
  layout.classList.toggle('workspace',workspace);
  if (workspace && !workspaceLanes.top.parentNode) layout.append(...Object.values(workspaceLanes));
  const lanePositions = {top:0,main:0,side:0};
  state.order.forEach((id,index) => {
    const panel = layoutPanels[id];
    const slot = panelOnly || workspace ? null : state.placements[id];
    if (slot) {
      panel.dataset.pinned = 'true';
      panel.style.setProperty('--slot-row',slot.row);
      panel.style.setProperty('--slot-column',(slot.column - 1) * 4 + 1);
      panel.style.setProperty('--slot-span',slot.width * 4);
    } else delete panel.dataset.pinned;
    panel.dataset.width = state.sizes[id]?.width ?? 'auto';
    panel.dataset.height = state.sizes[id]?.height ?? 'auto';
    const pixels = state.sizes[id]?.pixels;
    panel.style.setProperty('--panel-height', pixels ? pixels + 'px' : '');
    panel.style.setProperty('--map-height', pixels ? Math.max(80,pixels - (id === 'map' ? 133 : 113)) + 'px' : '');
    panel.hidden = panelOnly ? id !== detached : state.hidden.includes(id);
    const lane = laneOf(id);
    const parent = workspace ? workspaceLanes[lane] : layout;
    const position = workspace ? lanePositions[lane]++ : index;
    if (parent.children[position] !== panel) parent.insertBefore(panel,parent.children[position] ?? null);
  });
  if (!workspace) for (const lane of Object.values(workspaceLanes)) lane.remove();
  else for (const lane of Object.values(workspaceLanes)) lane.hidden = !lane.querySelector('.panel:not([hidden])');
  layout.classList.toggle('has-pins',!!layout.querySelector('[data-pinned]:not([hidden])'));
  document.body.classList.toggle('tall',state.tall);
  const undo = byId('undoLayout');
  if (undo) undo.disabled = !state.layoutHistory.length;
  byId('stationTitle').textContent = state.stationTitle || defaults.stationTitle;
  byId('stationEyebrow').textContent = state.stationEyebrow;
  byId('stationEyebrow').hidden = !state.stationEyebrow;
  const tx = activeTx();
  if (!liveMode) byId('traffic').textContent = tx ? stations[tx.id].call + ' transmitting' : 'No active transmissions';
  byId('count').textContent = Object.keys(state.links).length;
  byId('simulate').disabled = !Object.keys(state.links).length;
  if (liveMode) { renderLiveLinks(); renderLiveMap(); refreshStationLocations(); }
  else { renderLinks(tx); renderMap(); renderRadioIndicators(tx); }
  renderTicker();
  renderSkywarn();
  byId('temperature').textContent = state.units === 'metric' ? '12°C' : '54°F';
  byId('wind').textContent = state.units === 'metric' ? 'NW 14 km/h' : 'NW 9 mph';
  document.querySelector('.weather-body dl').hidden = !state.weatherDetails;
  document.querySelector('.radar-footer').hidden = !state.radarLegend;
  const fillOpacity = {light:.29,standard:.56,strong:.81}[state.radarOpacity];
  radarCells.forEach(cell => cell.setStyle({fillOpacity}));

  clearTimeout(expiryTimer);
  if (tx) expiryTimer = setTimeout(render, tx.until - Date.now() + 25);
  requestAnimationFrame(() => {
    if (!byId('linkMap').closest('[hidden]')) linkMap.invalidateSize();
    if (!byId('radarMap').closest('[hidden]')) radarMap.invalidateSize();
  });
}
const preferences = {
  map: [
    ['labels','Station labels',{call:'Callsign',number:'Node number',both:'Callsign and number',off:'Off'}],
    ['pulseSpeed','Pulse speed',{slow:'Slow',normal:'Normal',fast:'Fast'}],
    ['motion','Animate transmission pulses'],
    ['boundaries','Show regional boundaries']
  ],
  nodes: [
    ['nodeSort','Sort station links',{number:'Node number',call:'Callsign',activity:'Transmitting first'}],
    ['nodeDetails','Show station location'],
    ['defaultMode','Default connection mode',['Transceive','Monitor','Permanent']]
  ],
  linked: [['linkedDetails','Show connection time and reconnects']],
  weather: [
    ['units','Weather units',{us:'Fahrenheit and mph',metric:'Celsius and km/h'}],
    ['weatherDetails','Show wind and humidity']
  ],
  radar: [
    ['radarOpacity','Precipitation intensity',{light:'Subtle',standard:'Standard',strong:'High contrast'}],
    ['radarLegend','Show precipitation legend']
  ],
  ticker: [
    ['tickerNodes','Show linked node events'],
    ['tickerWeather','Show weather conditions'],
    ['tickerAlerts','Show weather alerts (NWS and SkywarnPlus)'],
    ['tickerDisplay','Display style',{scroll:'Scroll right to left',timed:'Timed messages'}],
    ['tickerSpeed','Ticker pace',{slow:'Slow',normal:'Normal',fast:'Fast'}]
  ],
  skywarn: [['skyDetails','Show alert text']]
};

function addPreference(parent, [setting,title,choices]) {
  const label = document.createElement('label');
  label.className = 'setting-row';
  const input = document.createElement(choices ? 'select' : 'input');
  if (choices) {
    const options = Array.isArray(choices) ? choices.map(value => [value,value]) : Object.entries(choices);
    input.replaceChildren(...options.map(([value,name]) => new Option(name,value)));
    input.value = state[setting];
  } else {
    input.type = 'checkbox';
    input.checked = state[setting];
  }
  input.onchange = () => {
    const change = {[setting]:choices ? input.value : input.checked};
    if (setting === 'tall') changeLayout(change);
    else update(change);
    if (setting === 'defaultMode') byId('mode').value = state.defaultMode;
  };
  label.append(title,input);
  parent.append(label);
}

function addPanelSize(parent, id) {
  for (const [axis, choices] of Object.entries({
    width:{auto:'Default',narrow:'Narrow',wide:'Wide',full:'Full row'},
    height:{auto:'Default',compact:'Compact',standard:'Standard',tall:'Tall',custom:'Drag-sized'}
  })) {
    const label = document.createElement('label');
    label.className = 'setting-row';
    const select = document.createElement('select');
    select.replaceChildren(...Object.entries(choices).map(([value,name]) => new Option(name,value)));
    select.value = state.sizes[id]?.[axis] ?? 'auto';
    if (axis === 'width' && state.layoutStyle === 'workspace' && !panelOnly) continue;
    if (axis === 'width' && state.placements[id]) {
      select.disabled = true;
      select.title = 'Adjust pinned width in Layouts → Tile placement';
    }
    if (axis === 'height') select.querySelector('option[value=custom]').disabled = true;
    select.onchange = () => {
      const size = {...state.sizes[id],[axis]:select.value};
      if (axis === 'height') delete size.pixels;
      changeLayout({sizes:{...state.sizes,[id]:size}});
    };
    label.append(axis === 'width' ? 'Panel width' : 'Panel height',select);
    parent.append(label);
  }
}

function addWatchPlaces(parent) {
  const form = document.createElement('form');
  form.className = 'watch-form';
  const label = document.createElement('label');
  const input = document.createElement('textarea');
  input.rows = 3;
  input.value = state.watchPlaces;
  label.append('Weather locations · U.S. ZIP code or name, latitude, longitude',input);
  input.placeholder = '63101\nLondon, 51.51, -0.13';
  const message = document.createElement('p');
  message.setAttribute('role','status');
  const save = document.createElement('button');
  save.textContent = 'Save locations';
  form.append(label,save,message);
  form.onsubmit = async event => {
    event.preventDefault();
    const value = input.value.trim();
    const places = parsePlaces(value);
    if (!places) {
      message.textContent = 'Enter up to six locations, one per line. Use a five-digit U.S. ZIP or name, latitude, longitude.';
      return;
    }
    save.disabled = true;
    message.textContent = 'Checking locations…';
    let failedZip = '';
    try {
      const resolved = [];
      for (const place of places) {
        failedZip = place.zip;
        resolved.push(await resolveWatchPlace(place));
      }
      update({watchPlaces:value,tickerWeather:true});
      message.textContent = resolved.length ? 'Saved · ' + resolved.map(place => place.name).join(' · ') : 'Weather locations cleared.';
    } catch {
      message.textContent = 'Could not look up ZIP ' + failedZip + '. Check the ZIP or enter coordinates.';
    } finally { save.disabled = false; }
  };
  parent.append(form);
}

function parsePlaces(value) {
  if (!value) return [];
  const lines = value.split(/\r?\n/).filter(line => line.trim());
  if (lines.length > 6) return null;
  const places = [];
  for (const line of lines) {
    const zip = line.trim().match(/^[0-9]{5}$/);
    if (zip) { places.push({zip:zip[0]}); continue; }
    const match = line.trim().match(/^(.+),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match || Math.abs(Number(match[2])) > 90 || Math.abs(Number(match[3])) > 180) return null;
    places.push({name:match[1].trim(), lat:match[2], lon:match[3]});
  }
  return places;
}

const zipLocations = new Map();
async function resolveWatchPlace(place) {
  if (!place.zip) return place;
  if (zipLocations.has(place.zip)) return zipLocations.get(place.zip);
  const result = await fetchJson('https://api.zippopotam.us/us/' + place.zip);
  const row = result.places?.[0];
  if (!row || !Number.isFinite(Number(row.latitude)) || !Number.isFinite(Number(row.longitude))) throw new Error('ZIP location unavailable');
  const location = {name:row['place name'] + ', ' + row['state abbreviation'],lat:row.latitude,lon:row.longitude};
  zipLocations.set(place.zip,location);
  return location;
}
let watchKey, watchEntries = [], tickerSignature, weatherRequest = 0;
let tickerItems = [], tickerIndex = 0, tickerTimer, tickerPaused;

const conditions = {0:'Clear',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Freezing fog',95:'Thunderstorms'};
async function fetchJson(url) {
  const response = await fetch(url,{signal:AbortSignal.timeout(12000)});
  if (liveMode && account && response.status === 401 && url.startsWith('api/')) location.reload();
  if (!response.ok) throw new Error('Feed unavailable');
  return response.json();
}
function refreshWatchWeather(force = false) {
  const signature = JSON.stringify([state.watchPlaces,state.units,state.tickerWeather,state.tickerAlerts]);
  if (!force && signature === watchKey) return;
  watchKey = signature;
  const request = ++weatherRequest;
  const places = parsePlaces(state.watchPlaces) ?? [];
  if (!force) watchEntries = places.length && (state.tickerWeather || state.tickerAlerts) ? ["Loading weather…"] : [];
  if (!places.length) return;
  Promise.all(places.map(async place => {
    let location;
    try { location = await resolveWatchPlace(place); }
    catch { return ['ZIP ' + place.zip + ' · Location lookup unavailable']; }
    const {name,lat,lon} = location;
    const results = [];
    const us = state.units === 'us';
    const weather = state.tickerWeather ? fetchJson('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({latitude:lat,longitude:lon,current:'temperature_2m,weather_code',temperature_unit:us ? 'fahrenheit' : 'celsius'}))
      .then(({current}) => name + ' · ' + current.temperature_2m + (us ? '°F' : '°C') + ' · ' + (conditions[current.weather_code] ?? (current.weather_code < 60 ? 'Drizzle' : current.weather_code < 70 ? 'Rain' : current.weather_code < 80 ? 'Snow' : 'Showers')) + ' · Open-Meteo')
      .catch(() => name + ' · Weather unavailable') : null;
    const alerts = state.tickerAlerts ? fetchJson('https://api.weather.gov/alerts/active?point=' + encodeURIComponent(lat + ',' + lon))
      .then(data => data.features.map(({properties}) => ({text:name + ' · ' + (properties.headline ?? properties.event) + ' · NWS',
        url:properties.web ?? properties['@id'] ?? 'https://www.weather.gov/',breaking:properties.severity === 'Extreme' || properties.severity === 'Severe'})))
      .catch(() => [name + ' · NWS alert coverage unavailable']) : null;
    if (weather) results.push(await weather);
    if (alerts) results.push(...await alerts);
    return results;
  })).then(entries => {
    if (weatherRequest !== request) return;
    watchEntries = entries.flat();
    renderTicker();
  });
}

function recentEvent(message) {
  return [message,...state.linkEvents].slice(0,4);
}

const newsSources = {off:'Off',abc:'ABC News','abc-us':'ABC News U.S.',kjrh:'KJRH Tulsa',kwgs:'Public Radio Tulsa',kosu:'KOSU Oklahoma'};
let newsKey;
let newsEntries = [];
let newsSequence = 0;

function refreshNews(force = false) {
  const selected = state.tickerNews && liveMode ? [state.newsNational,state.newsLocal,state.newsBreaking] : [];
  const signature = selected.join(',');
  if (!force && signature === newsKey) return;
  if (signature !== newsKey) newsEntries = [];
  newsKey = signature;
  const sequence = ++newsSequence;
  const sources = [...new Set(selected)].filter(id => id !== 'off' && Object.hasOwn(newsSources,id));
  if (!sources.length) return;
  Promise.all(sources.map(async id => {
    try { return [id,await fetchJson('api/news?source=' + id)]; }
    catch { return [id,null]; }
  })).then(results => {
    if (sequence !== newsSequence) return;
    const feeds = new Map(results);
    const make = (id, breaking, count) => {
      const feed = feeds.get(id);
      return (feed?.headlines ?? []).filter(entry => entry.breaking === breaking).slice(0,count)
        .map(entry => ({text:(breaking ? 'Breaking · ' : '') + entry.title + ' · ' + feed.source,breaking,url:entry.url}));
    };
    const items = [...make(selected[2],true,3),...make(selected[0],false,4),...make(selected[1],false,4)];
    newsEntries = [...new Map(items.map(item => [item.text,item])).values()];
    renderTicker();
  });
}

const tickerViewport = byId('tickerViewport');
let tickerHovered = false;
let tickerFocused = false;

function applyTickerItem(element, item) {
  const text = typeof item === 'string' ? item : item?.text ?? '';
  let destination;
  if (item?.url) {
    try {
      const url = new URL(item.url,location.href);
      if (['http:','https:'].includes(url.protocol) && !url.username && !url.password) destination = url;
    } catch {}
  }
  if (destination) {
    const link = document.createElement('a');
    link.className = 'ticker-headline';
    link.href = destination;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = text;
    element.append(link);
  } else element.textContent = text;
  element.classList.toggle('ticker-breaking',Boolean(item?.breaking));
}

function refreshTickerInteraction() {
  if (!tickerHovered && !tickerFocused) renderTicker();
  syncTickerPlayback();
}

tickerViewport.addEventListener('mouseenter',() => {
  tickerHovered = true;
  syncTickerPlayback();
});
tickerViewport.addEventListener('mouseleave',() => {
  tickerHovered = false;
  refreshTickerInteraction();
});
tickerViewport.addEventListener('focusin',() => {
  tickerFocused = true;
  syncTickerPlayback();
});
tickerViewport.addEventListener('focusout',event => {
  if (tickerViewport.contains(event.relatedTarget)) return;
  tickerFocused = false;
  queueMicrotask(refreshTickerInteraction);
});

function renderTicker() {
  refreshWatchWeather();
  refreshNews();
  const tx = activeTx();
  const nodeItems = state.tickerNodes && !liveMode ? Object.entries(state.links).map(([id,mode]) => stations[id].call + ' · ' + id + ' · ' + (tx?.id === id ? 'Transmitting' : 'Linked / ' + mode) + ' · Demo') : [];
  const events = state.tickerNodes && !liveMode ? state.linkEvents.map(event => event + ' · Demo') : [];
  const liveItems = liveMode && state.tickerNodes ? (liveSnapshot.links ?? []).map(link => 'Node ' + link.node + ' · ' + link.status.toLowerCase()) : [];
  const stationAlerts = liveMode && state.tickerAlerts && sky.status === 'active'
    ? (sky.alerts ?? '').split('\n').filter(Boolean).map(alert => ({text:alert + ' · SkywarnPlus',url:'?live=1&panel=skywarn',breaking:true})) : [];
  const items = [...stationAlerts,...newsEntries.filter(item => item.breaking),...events,...nodeItems,...liveItems,...watchEntries,...newsEntries.filter(item => !item.breaking)];
  if (!items.length) items.push(liveMode && state.tickerNodes ? (liveSnapshot.status === 'online' ? 'No direct links' : 'Local node status unavailable') : state.watchPlaces ? 'No updates available' : 'Add weather locations in Settings');
  const signature = JSON.stringify([items,state.tickerSpeed,state.tickerDisplay,reducedMotion.matches]);
  if (signature === tickerSignature) {
    if (tickerPaused !== state.tickerPaused) syncTickerPlayback();
    return;
  }
  if (tickerHovered || tickerFocused) return;
  tickerSignature = signature;
  const previous = tickerItems[tickerIndex];
  tickerItems = items;
  tickerIndex = Math.max(0,items.findIndex(item => (item?.text ?? item) === (previous?.text ?? previous)));
  showTickerItem();
}

function showTickerItem() {
  const list = byId('tickerItems');
  const entry = document.createElement('li');
  const scrolling = tickerItems.length > 0 && state.tickerDisplay === 'scroll' && !reducedMotion.matches;
  list.classList.toggle('ticker-scroll',scrolling);
  list.replaceChildren(entry);
  if (scrolling) {
    const group = document.createElement('span');
    group.className = 'ticker-group';
    for (const item of tickerItems) {
      const topic = document.createElement('span');
      applyTickerItem(topic,item);
      const star = document.createElement('span');
      star.className = 'ticker-star';
      star.setAttribute('aria-hidden','true');
      star.textContent = '★';
      group.append(topic,star);
    }
    entry.append(group);
    const copy = group.cloneNode(true);
    copy.setAttribute('aria-hidden','true');
    for (const link of copy.querySelectorAll('a')) link.tabIndex = -1;
    const width = group.scrollWidth || 65;
    const speed = {slow:45,normal:65,fast:95}[state.tickerSpeed] ?? 65;
    entry.style.setProperty('--ticker-distance',width + 'px');
    entry.style.setProperty('--ticker-duration',width / speed + 's');
    for (let remaining = list.parentElement.clientWidth; remaining > 0; remaining -= width) {
      entry.append(copy.cloneNode(true));
    }
  } else {
    applyTickerItem(entry,tickerItems[tickerIndex]);
  }
  byId('tickerPosition').textContent = !scrolling && tickerItems.length > 1 ? (tickerIndex + 1) + ' / ' + tickerItems.length : '';
  for (const id of ['tickerPrevious','tickerNext']) byId(id).hidden = scrolling || tickerItems.length < 2;
  byId('tickerPause').hidden = !scrolling && tickerItems.length < 2;
  syncTickerPlayback();
}

function syncTickerPlayback() {
  const list = byId('tickerItems');
  tickerPaused = state.tickerPaused;
  const paused = tickerPaused || tickerHovered || tickerFocused;
  list.classList.toggle('ticker-paused',paused);
  byId('tickerPause').textContent = tickerPaused ? 'Resume' : 'Pause';
  byId('tickerPause').setAttribute('aria-pressed',String(tickerPaused));
  clearTimeout(tickerTimer);
  if (!paused && tickerItems.length > 1 && !list.classList.contains('ticker-scroll')) {
    tickerTimer = setTimeout(() => stepTicker(1),{slow:15000,normal:10000,fast:6000}[state.tickerSpeed] ?? 10000);
  }
}

function stepTicker(offset) {
  if (tickerItems.length < 2) return;
  tickerIndex = (tickerIndex + offset + tickerItems.length) % tickerItems.length;
  showTickerItem();
}


let sky = {status:'unavailable',detail:'Local SkywarnPlus status feed unavailable.'};
async function refreshSkywarn() {
  try { sky = await fetchJson('api/skywarn'); }
  catch { sky = {status:'unavailable',detail:'Local SkywarnPlus status feed unavailable.'}; }
  renderSkywarn();
  renderTicker();
}
function renderSkywarn() {
  byId('skyState').textContent = {
    unavailable:'Status unavailable', missing:'Installation not detected', disabled:'Disabled',
    stale:'Enabled · alert status unavailable', clear:'Enabled · no active alerts', active:'Enabled · active alerts'
  }[sky.status] ?? 'Status unavailable';
  byId('skyState').dataset.status = sky.status;
  byId('skyDetail').textContent = sky.updatedAt ? (sky.source === 'state' ? 'State saved ' : 'Report updated ') + new Date(sky.updatedAt).toLocaleString() : sky.detail ?? '';
  byId('skyAlerts').hidden = !state.skyDetails || !sky.alerts;
  byId('skyAlerts').textContent = sky.alerts ?? '';
}

function addPresets(parent) {
  const form = document.createElement('form');
  form.className = 'preset-controls';
  const builtIn = [
    {name:'Everyday Monitoring',layout:arrangement(defaults)},
    {name:'Net Control Desk',layout:{...arrangement(defaults),order:['ticker','nodes','linked','map','skywarn','weather','radar'],sizes:{nodes:{width:'wide'},map:{width:'narrow'}},hidden:['radar','weather']}},
    {name:'Severe Weather Watch',layout:{...arrangement(defaults),order:['ticker','skywarn','radar','weather','nodes','linked','map'],sizes:{radar:{width:'wide',height:'standard'},weather:{width:'narrow'},nodes:{width:'wide'}},hidden:['map']}}
  ];
  const presets = [...builtIn,...state.layoutPresets];
  const name = document.createElement('input');
  name.placeholder = 'Layout name';
  name.setAttribute('aria-label','Layout name');
  name.maxLength = 48;
  name.required = true;
  const save = document.createElement('button');
  save.textContent = 'Save layout';
  const select = document.createElement('select');
  select.setAttribute('aria-label','Saved layouts');
  select.replaceChildren(new Option('Choose a layout',''),...presets.map((preset,index) => new Option(preset.name + (index < builtIn.length ? ' · Built-in' : ''),preset.name)));
  const load = document.createElement('button');
  load.type = 'button';
  load.textContent = 'Load layout';
  load.disabled = true;
  const message = document.createElement('p');
  message.setAttribute('role','status');
  select.onchange = () => { load.disabled = !select.value; };
  form.onsubmit = event => {
    event.preventDefault();
    const title = name.value.trim();
    if (!title) return;
    if (presets.some(preset => preset.name.toLowerCase() === title.toLowerCase())) {
      message.textContent = 'Choose a different name for this layout.';
      return;
    }
    update({layoutPresets:[...state.layoutPresets,{name:title,layout:arrangement(state)}]});
    presets.push({name:title,layout:arrangement(state)});
    select.add(new Option(title,title));
    select.value = title;
    load.disabled = false;
    name.value = '';
    message.textContent = title + ' saved.';
  };
  load.onclick = () => {
    const preset = presets.find(item => item.name === select.value);
    if (!preset) return;
    changeLayout(arrangement(preset.layout));
    renderSettings();
    const refreshed = parent.querySelector('[aria-label="Saved layouts"]');
    refreshed.value = preset.name;
    refreshed.dispatchEvent(new Event('change'));
    refreshed.focus();
    byId('layoutStatus').textContent = preset.name + ' layout loaded.';
  };
  form.append(name,save,select,load,message);
  parent.append(form);
}

function addPlacementEditor(parent) {
  const area = document.createElement('fieldset');
  area.className = 'placement-editor';
  const legend = document.createElement('legend');
  legend.textContent = 'Tile placement';
  const tile = document.createElement('select');
  tile.replaceChildren(...state.order.map(id => new Option(modules[id],id)));
  const row = document.createElement('select');
  row.replaceChildren(...Array.from({length:Object.keys(modules).length},(_,index) => new Option(String(index+1),String(index+1))));
  const column = document.createElement('select');
  column.replaceChildren(...['Left','Center','Right'].map((name,index) => new Option(name,String(index+1))));
  const width = document.createElement('select');
  width.replaceChildren(...['One column','Two columns','Full row'].map((name,index) => new Option(name,String(index+1))));
  function field(name, control) {
    const label = document.createElement('label');
    label.append(name,control);
    return label;
  }
  const pin = document.createElement('button');
  pin.textContent = 'Place tile';
  const auto = document.createElement('button');
  auto.textContent = 'Return to automatic';
  const status = document.createElement('p');
  status.setAttribute('role','status');
  function loadSlot() {
    const slot = state.placements[tile.value];
    row.value = String(slot?.row ?? 1);
    column.value = String(slot?.column ?? 1);
    const fallback = {narrow:1,wide:2,full:3}[state.sizes[tile.value]?.width] ?? ({ticker:3,map:2,weather:2}[tile.value] ?? 1);
    width.value = String(slot?.width ?? fallback);
    auto.disabled = !slot;
    status.textContent = slot ? 'Pinned to row ' + slot.row + '.' : 'Uses automatic placement.';
  }
  tile.onchange = loadSlot;
  pin.onclick = () => {
    const next = {row:Number(row.value),column:Number(column.value),width:Number(width.value)};
    if (next.column + next.width > 4) {
      status.textContent = 'That width does not fit at the selected column.';
      return;
    }
    const clash = Object.entries(state.placements).find(([id,slot]) => id !== tile.value && slot.row === next.row &&
      slot.column < next.column + next.width && next.column < slot.column + slot.width);
    if (clash) {
      status.textContent = 'That space is reserved by ' + modules[clash[0]] + '.';
      return;
    }
    changeLayout({placements:{...state.placements,[tile.value]:next}});
    loadSlot();
  };
  auto.onclick = () => {
    const placements = {...state.placements};
    delete placements[tile.value];
    changeLayout({placements});
    loadSlot();
  };
  area.append(legend,field('Tile',tile),field('Row',row),field('Start column',column),field('Width',width),pin,auto,status);
  parent.append(area);
  loadSlot();
}

function addThemeCatalogue(parent) {
  addPreference(parent,['theme','Color mode',{day:'Day',night:'Night'}]);
  const catalogue = document.createElement('fieldset');
  catalogue.className = 'theme-catalogue';
  const legend = document.createElement('legend');
  legend.textContent = 'Choose a theme';
  catalogue.append(legend);
  for (const [id,name] of Object.entries(palettes)) {
    const card = document.createElement('label');
    card.className = 'theme-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'palette';
    radio.value = id;
    radio.checked = state.palette === id;
    radio.onchange = () => update({palette:id});
    const previews = document.createElement('span');
    previews.className = 'theme-previews';
    previews.setAttribute('aria-hidden','true');
    for (const mode of ['day','night']) {
      const preview = document.createElement('span');
      preview.className = 'theme-preview';
      preview.dataset.palette = id;
      preview.dataset.theme = mode;
      preview.textContent = mode === 'day' ? 'Day' : 'Night';
      const swatches = document.createElement('span');
      swatches.className = 'theme-swatches';
      swatches.append(...Array.from({length:3},() => document.createElement('i')));
      preview.append(swatches);
      previews.append(preview);
    }
    card.append(radio,name,previews);
    catalogue.append(card);
  }
  parent.append(catalogue);
}

function renderSettings() {
  const parent = byId('settingsBody');
  parent.replaceChildren();
  byId('settingsTitle').textContent = configurationSections[settingsSection];
  const showTicker = settingsSection === 'ticker';
  byId('tickerPlayback').hidden = !showTicker;
  byId('tickerPreview').hidden = !showTicker;
  const tickerParent = byId(showTicker ? 'tickerPreview' : 'tickerBody');
  if (byId('tickerViewport').parentElement !== tickerParent) tickerParent.append(byId('tickerViewport'));
  for (const button of byId('configurationNav').children) {
    if (button.dataset.section === settingsSection) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  }
  if (settingsSection === 'appearance') {
    addThemeCatalogue(parent);
    return;
  }
  if (settingsSection === 'station') {
    const form = document.createElement('form');
    form.className = 'watch-form';
    const fields = {};
    for (const [key,label,maxLength] of [['stationTitle','Title',100],['stationEyebrow','Text above title',70]]) {
      const field = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = maxLength;
      input.value = state[key];
      fields[key] = input;
      field.append(label,input);
      form.append(field);
    }
    const save = document.createElement('button');
    save.textContent = 'Save heading';
    const status = document.createElement('p');
    status.setAttribute('role','status');
    form.append(save,status);
    form.onsubmit = event => {
      event.preventDefault();
      update({stationTitle:fields.stationTitle.value.trim() || defaults.stationTitle,
              stationEyebrow:fields.stationEyebrow.value.trim()});
      fields.stationTitle.value = state.stationTitle;
      status.textContent = 'Heading saved on this browser.';
    };
    parent.append(form);
    return;
  }
  if (preferences[settingsSection]) {
    const liveDemoSettings = {map:['labels'],nodes:['nodeSort','nodeDetails','defaultMode']};
    const controls = preferences[settingsSection].filter(([key]) => !liveMode || !liveDemoSettings[settingsSection]?.includes(key));
    controls.forEach(setting => addPreference(parent,setting));
    if (liveMode && settingsSection === 'map') {
      addPreference(parent,['automaticLocations','Use published AllStarLink locations']);
      addStationLocations(parent);
    }
    addPanelSize(parent,settingsSection);
    if (settingsSection === 'ticker') {
      addWatchPlaces(parent);
      addPreference(parent,['tickerNews','Show news headlines']);
      addPreference(parent,['newsNational','National news source',newsSources]);
      addPreference(parent,['newsLocal','Local news source',newsSources]);
      addPreference(parent,['newsBreaking','Breaking news source',newsSources]);
    }
    return;
  }
  const undo = document.createElement('button');
  undo.id = 'undoLayout';
  undo.textContent = 'Undo layout';
  undo.disabled = !state.layoutHistory.length;
  undo.onclick = () => { undoLayout(); renderSettings(); };
  parent.append(undo);
  addPresets(parent);
  const style = document.createElement('select');
  style.replaceChildren(new Option('Workspace columns','workspace'),new Option('Grid with tile placement','grid'));
  style.value = state.layoutStyle;
  style.setAttribute('aria-label','Layout style');
  style.onchange = () => { changeLayout({layoutStyle:style.value}); renderSettings(); };
  const styleRow = document.createElement('label');
  styleRow.className = 'setting-row';
  styleRow.append('Layout style',style);
  parent.append(styleRow);
  if (state.layoutStyle === 'grid') addPlacementEditor(parent);
  state.order.forEach((id,index) => {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const label = document.createElement('label');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !state.hidden.includes(id);
    toggle.onchange = () => changeLayout({hidden:toggle.checked ? state.hidden.filter(item=>item!==id) : [...state.hidden,id]});
    label.append(toggle,' ' + modules[id]);
    if (state.layoutStyle === 'workspace') {
      const lane = document.createElement('select');
      lane.setAttribute('aria-label',modules[id] + ' placement');
      lane.replaceChildren(new Option('Full width at top','top'),new Option('Main column','main'),new Option('Side column','side'));
      lane.value = laneOf(id);
      lane.onchange = () => { changeLayout({lanes:{...state.lanes,[id]:lane.value}}); renderSettings(); };
      row.append(label,lane);
    } else row.append(label);
    const siblings = state.layoutStyle === 'workspace' ? state.order.filter(other => laneOf(other) === laneOf(id)) : state.order;
    for (const [offset,name] of [[-1,'Move up'],[1,'Move down']]) {
      const button = document.createElement('button');
      const target = siblings[siblings.indexOf(id) + offset];
      button.textContent = name;
      button.setAttribute('aria-label',name + ' ' + modules[id]);
      button.disabled = !target;
      button.onclick = () => {
        const order = [...state.order];
        const other = order.indexOf(target);
        [order[index],order[other]] = [order[other],order[index]];
        changeLayout({order});
        renderSettings();
        [...parent.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === button.getAttribute('aria-label') && !item.disabled)?.focus();
      };
      row.append(button);
    }
    parent.append(row);
  });
  addPreference(parent,['tall','Tall maps']);
}

function enableWeatherOverlays() {
  for (const [name,zIndex] of [['network-base',300],['weather-radar',340],['weather-counties',360],['weather-warnings',375]]) {
    const pane = linkMap.createPane(name);
    pane.style.zIndex = zIndex;
    pane.style.pointerEvents = 'none';
  }
  const radar = byId('mapRadar');
  const play = byId('mapRadarPlay');
  const status = byId('mapWeatherStatus');
  const counties = byId('mapCounties');
  const warnings = byId('mapWarnings');
  let frames = [];
  let frameIndex = 0;
  let radarLayer;
  let pendingRadar;
  let running = false;
  let refreshId = 0;
  let countyLayer;
  let warningLayer;

  function clearRadar() {
    if (pendingRadar) pendingRadar.remove();
    if (radarLayer) radarLayer.remove();
    radarLayer = pendingRadar = null;
  }

  function showFrame(index) {
    const frame = frames[index];
    if (!frame) return;
    frameIndex = index;
    if (pendingRadar) pendingRadar.remove();
    const layer = L.tileLayer(frame.url,{pane:'weather-radar',opacity:0,maxNativeZoom:frame.maxZoom,
      noWrap:true,attribution:frame.source});
    pendingRadar = layer;
    let failed = false;
    layer.on('tileerror',() => { failed = true; });
    layer.once('load',() => {
      if (pendingRadar !== layer) return;
      pendingRadar = null;
      if (failed) {
        layer.remove();
        status.textContent = frame.source + (radarLayer ? ' · Holding last complete frame' : ' · Radar tiles unavailable');
        return;
      }
      layer.setOpacity(.72);
      radarLayer?.remove();
      radarLayer = layer;
      status.textContent = frame.source + ' · ' + frame.label;
    });
    layer.addTo(linkMap);
  }

  async function refreshRadar(reset = false) {
    const request = ++refreshId;
    const source = radar.value;
    if (reset) {
      frames = [];
      running = false;
      play.textContent = 'Play radar';
      play.disabled = true;
      clearRadar();
    }
    if (source === 'off') {
      status.textContent = '';
      return;
    }
    if (reset) status.textContent = 'Loading radar…';
    try {
      let next;
      if (source === 'us') {
        const cache = Math.floor(Date.now()/60000);
        next = [30,25,20,15,10,5,0].map(minutes => ({
          url:'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q' +
            (minutes ? '-m' + String(minutes).padStart(2,'0') + 'm' : '') + '/{z}/{x}/{y}.png?v=' + cache,
          source:'Iowa Environmental Mesonet',maxZoom:8,label:minutes ? minutes + ' min before latest' : 'Latest available'
        }));
      } else {
        const data = await fetchJson('https://api.rainviewer.com/public/weather-maps.json');
        next = (data.radar?.past ?? []).filter(frame => /^\/v2\/radar\/[a-z0-9_]+$/i.test(frame.path) && Number.isFinite(frame.time))
          .map(frame => ({url:'https://tilecache.rainviewer.com' + frame.path + '/256/{z}/{x}/{y}/2/1_1.png',
            source:'RainViewer',maxZoom:7,label:new Date(frame.time*1000).toLocaleTimeString()}));
      }
      if (request !== refreshId) return;
      if (!next.length) throw new Error('No frames');
      frames = next;
      play.disabled = frames.length < 2;
      if (!running) showFrame(frames.length - 1);
    } catch {
      if (request === refreshId) status.textContent = 'Radar feed unavailable';
    }
  }

  radar.onchange = () => refreshRadar(true);
  play.onclick = () => {
    running = !running;
    play.textContent = running ? 'Pause radar' : 'Play radar';
    if (running && !pendingRadar) showFrame((frameIndex + 1) % frames.length);
  };
  setInterval(() => {
    if (running && !pendingRadar && frames.length) showFrame((frameIndex + 1) % frames.length);
  },1100);
  counties.onchange = async () => {
    if (!counties.checked) { countyLayer?.remove(); return; }
    try {
      if (!countyLayer) {
        countyLayer = L.geoJSON(await fetchJson('us-counties.json'),{
          pane:'weather-counties',interactive:false,color:'#8ba2b7',weight:.7,opacity:.8,
          attribution:'Counties © U.S. Census Bureau'
        });
      }
      if (counties.checked) countyLayer.addTo(linkMap);
    } catch {
      counties.checked = false;
      status.textContent = 'County boundaries unavailable';
    }
  };

  function refreshWarnings() {
    warningLayer?.remove();
    warningLayer = null;
    if (!warnings.checked || linkMap.getSize().x < 1 || linkMap.getSize().y < 1) return;
    const bounds = linkMap.getBounds();
    const crs = linkMap.options.crs;
    const sw = crs.project(bounds.getSouthWest());
    const ne = crs.project(bounds.getNorthEast());
    const size = linkMap.getSize();
    const scale = Math.min(1,1600/Math.max(size.x,size.y));
    const query = new URLSearchParams({
      bbox:[sw.x,sw.y,ne.x,ne.y].join(','),bboxSR:'3857',imageSR:'3857',
      size:[Math.round(size.x*scale),Math.round(size.y*scale)].join(','),
      format:'png32',transparent:'true',layers:'show:1',f:'image',_t:String(Math.floor(Date.now()/60000))
    });
    const url = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/export?' + query;
    warningLayer = L.imageOverlay(url,bounds,{
      pane:'weather-warnings',opacity:.55,attribution:'NWS active watches, warnings and advisories'
    }).on('error',() => { status.textContent = 'NWS alert overlay unavailable'; }).addTo(linkMap);
  }

  warnings.onchange = refreshWarnings;
  linkMap.on('moveend resize',() => { if (warnings.checked) refreshWarnings(); });
  setInterval(() => { refreshRadar(); refreshWarnings(); },60000);
}

linkMap = buildMap('linkMap',home,5);
enableWeatherOverlays();
radarMap = buildMap('radarMap',home,6);
linksLayer = L.layerGroup().addTo(linkMap);
linkMap.on('move zoom resize',queueMapLabels);
document.fonts?.ready.then(queueMapLabels);
const precipitation = [
  [[39.6,-92.5],[39.9,-91.8],[39.6,-90.2],[38.9,-89.8],[38.3,-90.2],[38.6,-91.5]],
  [[39.6,-91.9],[39.7,-91.4],[39.3,-90.3],[38.9,-90.2],[38.6,-90.6],[39.1,-91.2]],
  [[39.4,-91.5],[39.4,-91.0],[39.0,-90.5],[38.9,-90.7],[39.0,-91.0]]
];
precipitation.forEach((points,index) => {
  const hue = ['#2772a2','#35b281','#e6bf46'][index];
  radarCells.push(L.polygon(points,{color:hue,weight:1,interactive:false}).addTo(radarMap));
});
L.circleMarker(home,{radius:5,color:'#e8f5ff',weight:2,fillOpacity:.4}).bindTooltip('St. Louis').addTo(radarMap);
loadBoundaries();
byId('theme').onclick = () => update({theme:state.theme === 'night' ? 'day' : 'night'});
function showConfiguration(focus = false) {
  if (liveMode && !account) return;
  const section = new URLSearchParams(location.search).get('configure');
  const open = !callerOnly && Object.hasOwn(configurationSections,section) && account?.role !== 'Observer';
  const wasOpen = !byId('configuration').hidden;
  byId('configuration').hidden = !open;
  byId('dashboard').hidden = open;
  byId('customize').hidden = open;
  if (open) {
    settingsSection = section;
    renderSettings();
    if (focus && !wasOpen) byId('configurationTitle').focus();
  } else if (wasOpen) {
    byId('tickerBody').append(byId('tickerViewport'));
    render();
    if (focus) byId('customize').focus();
  }
}
function navigateConfiguration(section) {
  const url = new URL(location.href);
  if (section) url.searchParams.set('configure',section);
  else url.searchParams.delete('configure');
  history.pushState(null,'',url);
  showConfiguration(true);
}
for (const [section,name] of Object.entries(configurationSections)) {
  const button = document.createElement('button');
  button.dataset.section = section;
  button.textContent = name;
  button.onclick = () => navigateConfiguration(section);
  byId('configurationNav').append(button);
}
byId('customize').onclick = () => navigateConfiguration('station');
byId('backDashboard').onclick = () => navigateConfiguration(null);
addEventListener('popstate',() => showConfiguration(true));
const clockFormat = new Intl.DateTimeFormat(undefined,{
  weekday:'short',month:'short',day:'numeric',year:'numeric',
  hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'
});
function updateStationClock() {
  const now = new Date();
  byId('stationClock').dateTime = now.toISOString();
  byId('stationClock').textContent = clockFormat.format(now);
}
updateStationClock();
setInterval(updateStationClock,1000);
byId('mode').value = state.defaultMode;
byId('fit').onclick = fitNetwork;
byId('simulate').onclick = () => {
  const candidates = Object.keys(state.links);
  transmit(candidates.find(id => stations[id].coords) || candidates[0]);
};
byId('connect').onsubmit = event => {
  event.preventDefault();
  const id = byId('nodeInput').value;
  if (!stations[id] || state.links[id]) return;
  update({links:{...state.links,[id]:byId('mode').value},linkEvents:recentEvent(stations[id].call + ' · ' + id + ' connected')});
  byId('feedback').textContent = 'Connected ' + stations[id].call + '.';
};
document.querySelectorAll('[data-pop]').forEach(button => {
  button.onclick = () => {
    const url = new URL(location.href);
    url.searchParams.delete('configure');
    url.searchParams.set('panel',button.dataset.pop);
    const popup = window.open(url,'crusader-' + button.dataset.pop,'popup,width=920,height=670');
    if (popup) popup.focus();
    else location.assign(url);
  };
});
function enablePanelDragging() {
  const layout = byId('layout');
  const status = byId('layoutStatus');
  let drag;
  for (const panel of layout.children) {
    const id = panel.dataset.module;
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'panel-grip';
    handle.textContent = '⠿';
    handle.setAttribute('aria-label','Move ' + modules[id]);
    handle.title = 'Drag to move, or use arrow keys';
    panel.querySelector('.panel-actions')?.prepend(handle);

    handle.addEventListener('keydown',event => {
      const offset = {ArrowLeft:-1,ArrowUp:-1,ArrowRight:1,ArrowDown:1}[event.key];
      if (!offset || state.placements[id]) return;
      event.preventDefault();
      const visible = state.order.filter(item => !state.hidden.includes(item) && !state.placements[item]);
      const target = visible[visible.indexOf(id) + offset];
      if (target) movePanel(id,target,offset > 0);
      handle.focus();
    });
    handle.addEventListener('pointerdown',event => {
      if (event.button !== 0 || drag || state.layoutStyle === 'workspace' || state.placements[id]) return;
      stopAnimations();
      drag = {id:event.pointerId,panel,handle,startX:event.clientX,startY:event.clientY,active:false};
      layout.setPointerCapture(event.pointerId);
    });
  }

  const animations = new Map();
  function stopAnimations() {
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
  }

  layout.addEventListener('pointermove',event => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active && Math.hypot(dx,dy) < 5) return;
    drag.active = true;
    drag.panel.classList.add('panel-dragging');
    if (!reducedMotion.matches) drag.panel.style.transform = `translate3d(${dx}px,${dy}px,0)`;
    clearDrop(drag.target);
    drag.target = dropTarget(event.clientX,event.clientY,drag.panel);
    if (!drag.target) return;
    const hit = drag.target;
    const box = hit.getBoundingClientRect();
    const stacked = matchMedia('(max-width:900px)').matches || box.width >= layout.clientWidth - 1;
    drag.after = stacked ? event.clientY >= box.top + box.height / 2 : event.clientX >= box.left + box.width / 2;
    hit.dataset.drop = drag.after ? 'after' : 'before';
    hit.dataset.dropAxis = stacked ? 'row' : 'column';
  });

  function dropTarget(x,y,panel) {
    const hit = document.elementFromPoint(x,y)?.closest('[data-module]');
    if (hit?.parentElement === layout && hit !== panel) return hit;
    const bounds = layout.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    let closest = null;
    let distance = Infinity;
    for (const tile of layout.children) {
      if (tile === panel || tile.hidden) continue;
      const box = tile.getBoundingClientRect();
      const gap = Math.hypot(Math.max(box.left-x,0,x-box.right),Math.max(box.top-y,0,y-box.bottom));
      if (gap >= distance) continue;
      closest = tile;
      distance = gap;
    }
    return distance <= 28 ? closest : null;
  }

  function finish(event) {
    if (drag?.id !== event.pointerId) return;
    const {panel,handle,target,after,active} = drag;
    drag = null;
    const before = new Map();
    if (active && !reducedMotion.matches) {
      for (const tile of layout.children) {
        if (!tile.hidden) before.set(tile,tile.getBoundingClientRect());
      }
    }
    panel.classList.remove('panel-dragging');
    panel.style.removeProperty('transform');
    clearDrop(target);
    if (layout.hasPointerCapture(event.pointerId)) layout.releasePointerCapture(event.pointerId);
    if (event.type === 'pointerup' && target) {
      movePanel(panel.dataset.module,target.dataset.module,after);
      handle.focus({preventScroll:true});
    }
    for (const [tile,start] of before) {
      const end = tile.getBoundingClientRect();
      const dx = start.left - end.left;
      const dy = start.top - end.top;
      if (!dx && !dy) continue;
      const animation = tile.animate(
        [{transform:`translate3d(${dx}px,${dy}px,0)`},{transform:'none'}],
        {duration:210,easing:'cubic-bezier(.2,.75,.25,1)'}
      );
      animations.set(tile,animation);
      animation.onfinish = () => animations.delete(tile);
    }
  }
  for (const type of ['pointerup','pointercancel','lostpointercapture']) layout.addEventListener(type,finish);

  function clearDrop(target) {
    target?.removeAttribute('data-drop');
    target?.removeAttribute('data-drop-axis');
  }

  function movePanel(id,target,after) {
    const order = state.order.filter(item => item !== id);
    order.splice(order.indexOf(target) + Number(after),0,id);
    changeLayout({order});
    status.textContent = modules[id] + (after ? ' moved after ' : ' moved before ') + modules[target] + '.';
  }
}

function enablePanelResizing() {
  const layout = byId('layout');
  const preview = document.createElement('div');
  preview.className = 'resize-preview';
  preview.hidden = true;
  document.body.append(preview);

  for (const panel of layout.children) {
    const id = panel.dataset.module;
    const content = document.createElement('div');
    content.className = 'panel-content';
    content.append(...panel.children);
    panel.append(content);
    const edges = {left:[-1,0],right:[1,0],top:[0,-1],bottom:[0,1],corner:[1,1]};
    for (const [edge,[horizontal,vertical]] of Object.entries(edges)) {
      const handle = document.createElement('span');
      handle.className = 'resize-edge resize-' + edge;
      handle.setAttribute('aria-hidden','true');
      panel.append(handle);
      let gesture;
      handle.onpointerdown = event => {
        if (event.button !== 0 || gesture) return;
        event.preventDefault();
        gesture = {pointer:event.pointerId,x:event.clientX,y:event.clientY,box:panel.getBoundingClientRect(),next:{}};
        handle.setPointerCapture(event.pointerId);
        panel.classList.add('panel-resizing');
      };
      handle.onpointermove = event => {
        if (gesture?.pointer !== event.pointerId) return;
        const {box} = gesture;
        const dx = horizontal * (event.clientX - gesture.x);
        const dy = vertical * (event.clientY - gesture.y);
        const next = {};
        let width = box.width;
        let height = box.height;
        if (state.layoutStyle !== 'workspace' && !state.placements[id] && !matchMedia('(max-width:900px)').matches && Math.abs(dx) >= 6) {
          const ratio = (box.width + dx) / layout.clientWidth;
          next.width = ratio < .5 ? 'narrow' : ratio < .84 ? 'wide' : 'full';
          const columns = {narrow:4,wide:8,full:12}[next.width];
          const gap = parseFloat(getComputedStyle(layout).columnGap) || 0;
          width = (layout.clientWidth + gap) * columns / 12 - gap;
        }
        if (Math.abs(dy) >= 6) {
          height = Math.max(120,Math.min(960,Math.round((box.height + dy) / 12) * 12));
          Object.assign(next,{height:'custom',pixels:height});
        }
        gesture.next = next;
        preview.hidden = !Object.keys(next).length;
        const grid = layout.getBoundingClientRect();
        const anchoredLeft = horizontal < 0 ? box.right - width : box.left;
        const left = Math.max(grid.left,Math.min(anchoredLeft,grid.right - width));
        const top = vertical < 0 ? box.bottom - height : box.top;
        Object.assign(preview.style,{left:left + 'px',top:top + 'px',width:width + 'px',height:height + 'px'});
      };
      function finish(event) {
        if (gesture?.pointer !== event.pointerId) return;
        const {next} = gesture;
        gesture = null;
        preview.hidden = true;
        panel.classList.remove('panel-resizing');
        if (event.type === 'pointerup' && Object.keys(next).length) {
          changeLayout({sizes:{...state.sizes,[id]:{...state.sizes[id],...next}}});
          byId('layoutStatus').textContent = modules[id] + ' resized.';
        }
      }
      for (const type of ['pointerup','pointercancel','lostpointercapture']) handle.addEventListener(type,finish);
    }
  }
}

if (!panelOnly) {
  enablePanelDragging();
  enablePanelResizing();
}
function addStationLocations(parent) {
  const form = document.createElement('form');
  form.className = 'watch-form';
  const label = document.createElement('label');
  const input = document.createElement('textarea');
  input.rows = 4;
  input.placeholder = 'Node number, latitude, longitude';
  input.value = Object.entries(state.stationLocations).map(([node, coords]) => [node,...coords].join(', ')).join('\n');
  label.append('Manual location overrides · node number, latitude, longitude',input);
  const save = document.createElement('button');
  save.textContent = 'Save station locations';
  const status = document.createElement('p');
  status.setAttribute('role','status');
  form.append(label,save,status);
  form.onsubmit = event => {
    event.preventDefault();
    const locations = {};
    const lines = input.value.trim().split(/\r?\n/).filter(line => line.trim());
    for (const line of lines) {
      const [node,lat,lon,...extra] = line.split(',').map(value => value.trim());
      const decimal = /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;
      if (!/^[0-9]{3,10}$/.test(node) || !decimal.test(lat ?? '') || !decimal.test(lon ?? '') ||
          extra.length || Math.abs(Number(lat)) > 85 || Math.abs(Number(lon)) > 180 || Object.hasOwn(locations,node)) {
        status.textContent = 'Enter one unique node per line with latitude from −85 to 85 and longitude from −180 to 180.';
        return;
      }
      locations[node] = [Number(lat),Number(lon)];
    }
    update({stationLocations:locations});
    fitNetwork();
    status.textContent = 'Station locations saved in this browser.';
  };
  parent.append(form);
}

let publishedLocations = {};
let locationFeedStatus = '';
let locationRequestKey = '';
let locationRefreshAt = 0;
function stationCoords(node) {
  return state.stationLocations[node] ?? (state.automaticLocations ? publishedLocations[node] : undefined);
}

async function refreshStationLocations() {
  if (!state.automaticLocations || liveSnapshot.status !== 'online') return;
  const nodes = [...new Set([liveSnapshot.node,...liveSnapshot.links.map(link => link.node)])]
    .filter(node => /^[0-9]{3,10}$/.test(node)).sort();
  if (!nodes.length) return;
  const key = nodes.join(',');
  if (key === locationRequestKey && Date.now() < locationRefreshAt) return;
  locationRequestKey = key;
  locationRefreshAt = Date.now() + 60000;
  try {
    const chunks = [];
    for (let i = 0; i < nodes.length; i += 512) {
      chunks.push(fetchJson('api/station-locations?nodes=' + nodes.slice(i,i+512).join(',')));
    }
    const results = await Promise.all(chunks);
    if (locationRequestKey !== key) return;
    publishedLocations = Object.assign({},...results.map(result => result.locations));
    locationFeedStatus = results[0].status;
    if (locationFeedStatus === 'online') locationRefreshAt = Date.now() + 300000;
  } catch {
    if (locationRequestKey !== key) return;
    locationFeedStatus = 'unavailable';
  }
  renderLiveMap();
}

let liveActivity = {status:'disabled',active:[]};
function peerReceiving(link) {
  return liveActivity.status === 'online' && link.status === 'ESTABLISHED' && liveActivity.active.includes(link.node);
}
let liveMapSignature;
let lastFittedStations;
function renderLiveMap() {
  const online = liveSnapshot.status === 'online';
  const node = liveSnapshot.node;
  const links = online ? liveSnapshot.links : [];
  const local = stationCoords(node);
  const plotted = local ? links.filter(link => stationCoords(link.node)) : [];
  const active = links.filter(peerReceiving).map(link => link.node);
  byId('txLegend').hidden = liveActivity.status !== 'online';
  const label = !online ? 'Local node status unavailable'
    : !local ? (locationFeedStatus === 'unavailable' && state.automaticLocations ? 'AllStarLink locations unavailable · Add a control node override in Settings' : 'Control node location needed · Check Settings')
    : links.length ? plotted.length + ' of ' + links.length + ' direct links plotted' : 'No direct links';
  const summary = label + (active.length ? ' · RX from ' + active.join(', ') : liveActivity.status === 'unavailable' ? ' · RX telemetry unavailable' : '');
  if (byId('traffic').textContent !== summary) byId('traffic').textContent = summary;
  byId('fit').disabled = !local;
  const hue = color('--accent');
  const signature = JSON.stringify([node,local,hue,state.motion,state.pulseSpeed,reducedMotion.matches,Boolean(byId('linkMap').closest('[hidden]')),plotted.map(link => [link.node,link.status,peerReceiving(link),stationCoords(link.node)])]);
  if (signature === liveMapSignature) return;
  liveMapSignature = signature;
  cancelAnimationFrame(pulseFrame);
  linksLayer.clearLayers();
  const paths = [];
  if (local) L.circleMarker(local,{radius:9,color:hue,fillOpacity:.27,weight:3})
    .bindTooltip('Control · ' + node,{permanent:true,direction:'center',className:'network-label'}).addTo(linksLayer);
  for (const link of plotted) {
    const coords = stationCoords(link.node);
    const receiving = peerReceiving(link);
    if (receiving) paths.push([coords,local]);
    L.polyline([local,coords],{color:receiving ? color('--tx') : hue,weight:receiving ? 3 : 2,dashArray:link.status === 'CONNECTING' ? '6 6' : null}).addTo(linksLayer);
    L.circleMarker(coords,{radius:5,color:hue,fillOpacity:.75})
      .bindTooltip('Node ' + link.node,{permanent:true,direction:'center',className:'network-label'}).addTo(linksLayer);
  }
  queueMapLabels();
  if (paths.length && state.motion && !reducedMotion.matches && !byId('linkMap').closest('[hidden]')) {
    animatePulses(paths,Date.now(),() => true);
  }
  const stations = JSON.stringify([local,...plotted.map(link => stationCoords(link.node))]);
  if (local && stations !== lastFittedStations && !byId('linkMap').closest('[hidden]')) {
    lastFittedStations = stations;
    fitNetwork();
  }
}

function renderLiveLinks() {
  const list = byId('links');
  const status = byId('liveStatus');
  const online = liveSnapshot.status === 'online';
  const links = liveSnapshot.links ?? [];
  const peers = liveSnapshot.controlPeers ?? [];
  const form = byId('liveControl');
  const select = byId('livePeer');
  const entry = byId('livePeerEntry');
  const freeEntry = liveSnapshot.freeEntry === true;
  form.hidden = !peers.length && !freeEntry;
  select.hidden = select.disabled = freeEntry;
  entry.hidden = entry.disabled = !freeEntry;
  document.querySelector('.demo').textContent = account ? 'LIVE / ' + account.role.toUpperCase() : 'LIVE / READ-ONLY';
  if (JSON.stringify([...select.options].map(option => option.value)) !== JSON.stringify(peers)) {
    const previous = select.value || new URLSearchParams(location.search).get('peer');
    select.replaceChildren(...peers.map(peer => new Option('Node ' + peer,peer)));
    if (peers.includes(previous)) select.value = previous;
  }
  form.querySelector('button').disabled = !online || linkCommandBusy;
  renderFavorites();
  byId('count').textContent = online ? links.length : '—';
  byId('controlNode').textContent = liveSnapshot.node ?? 'Local node';
  status.textContent = online ? (links.length ? 'Direct links from Asterisk' : 'No direct links') : 'Local node status unavailable';
  const signature = JSON.stringify([links,freeEntry,peers,state.linkedDetails,links.map(peerReceiving)]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.node : null;
  list.replaceChildren(...links.map(link => {
    const row = document.createElement('div');
    row.className = 'link-row';
    const eligible = !form.hidden && /^[1-9][0-9]{2,9}$/.test(link.node) && (freeEntry || peers.includes(link.node));
    const id = document.createElement(eligible ? 'button' : 'strong');
    id.textContent = link.node;
    if (eligible) {
      id.dataset.node = link.node;
      id.setAttribute('aria-label','Select node ' + link.node + ' for disconnect');
      id.onclick = () => {
        if (panelOnly && detached === 'linked') {
          const target = new URL(location.href);
          target.searchParams.set('panel','nodes');
          target.searchParams.set('peer',link.node);
          window.open(target,'crusader-node-control','popup');
        } else {
          if (state.hidden.includes('nodes')) changeLayout({hidden:state.hidden.filter(module => module !== 'nodes')});
          byId(freeEntry ? 'livePeerEntry' : 'livePeer').value = link.node;
          byId('liveAction').value = 'disconnect';
          renderFavorites();
          byId('liveAction').focus();
        }
      };
    }
    id.classList.add('linked-node-number');
    id.classList.toggle('link-receiving',peerReceiving(link));
    const details = (link.mode ?? 'Mode unavailable') + ' · ' + link.status + ' · ' + link.direction +
      (state.linkedDetails ? ' · ' + link.duration + ' · Reconnects: ' + link.reconnects : '') +
      (peerReceiving(link) ? ' · Receiving' : '');
    row.append(id,document.createTextNode(details));
    return row;
  }));
  if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.node === focused)?.focus({preventScroll:true});
}

function chosenPeer() {
  return byId(liveSnapshot.freeEntry ? 'livePeerEntry' : 'livePeer').value.trim();
}

function renderFavorites() {
  const select = byId('liveFavorites');
  const peer = chosenPeer();
  const allowed = liveSnapshot.controlPeers ?? [];
  const entries = Object.entries(state.favoritePeers).filter(([id]) => liveSnapshot.freeEntry || allowed.includes(id));
  const signature = JSON.stringify(entries);
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(new Option('Favorites',''), ...entries.map(([id,name]) => new Option(name ? name + ' · ' + id : 'Node ' + id,id)));
  }
  select.value = entries.some(([id]) => id === peer) ? peer : '';
  byId('saveFavorite').disabled = !/^[1-9][0-9]{2,9}$/.test(peer) || peer === liveSnapshot.node;
  byId('removeFavorite').disabled = !select.value;
}

byId('liveFavorites').onchange = event => {
  const peer = event.target.value;
  if (!peer) return;
  byId(liveSnapshot.freeEntry ? 'livePeerEntry' : 'livePeer').value = peer;
  renderFavorites();
};
byId('livePeer').onchange = renderFavorites;
byId('livePeerEntry').oninput = renderFavorites;
byId('saveFavorite').onclick = () => {
  const peer = chosenPeer();
  if (!/^[1-9][0-9]{2,9}$/.test(peer) || peer === liveSnapshot.node) return;
  const label = window.prompt('Favorite name (optional)',state.favoritePeers[peer] ?? '');
  if (label === null) return;
  update({favoritePeers:{...state.favoritePeers,[peer]:label.trim().slice(0,80)}});
  byId('liveCommandStatus').textContent = 'Saved node ' + peer + ' to favorites.';
};
byId('removeFavorite').onclick = () => {
  const peer = byId('liveFavorites').value;
  if (!Object.hasOwn(state.favoritePeers,peer)) return;
  const favoritePeers = {...state.favoritePeers};
  delete favoritePeers[peer];
  update({favoritePeers});
  byId('liveCommandStatus').textContent = 'Removed node ' + peer + ' from favorites.';
};

let linkCommandBusy = false;
byId('liveControl').onsubmit = async event => {
  event.preventDefault();
  if (linkCommandBusy || liveSnapshot.status !== 'online') return;
  const peer = chosenPeer();
  const action = byId('liveAction').value;
  const status = byId('liveCommandStatus');
  if (!/^[1-9][0-9]{2,9}$/.test(peer) || peer === liveSnapshot.node) {
    status.textContent = 'Enter a numeric peer node different from the control node.';
    return;
  }
  linkCommandBusy = true;
  renderLiveLinks();
  status.textContent = 'Waiting for Asterisk to confirm…';
  try {
    const response = await fetch('api/link',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({peer,action}),
      signal:AbortSignal.timeout(35000)
    });
    const result = await response.json();
    status.textContent = result.message;
    if (response.status === 401) location.reload();
  } catch {
    status.textContent = 'Confirmation unavailable. Check Station Links before retrying.';
  } finally {
    linkCommandBusy = false;
    renderLiveLinks();
  }
};

async function refreshLiveLinks() {
  try { liveSnapshot = await fetchJson('api/node'); }
  catch { liveSnapshot = {node:liveSnapshot.node}; }
  renderLiveLinks();
  renderLiveMap();
  refreshStationLocations();
  renderTicker();
  setTimeout(refreshLiveLinks,3000);
}

function renderRadioIndicators(demoRx) {
  const indicators = [
    ['radioTx','Transmitter',liveActivity.tx],
    ['radioRx',liveMode ? 'Linked audio receive' : 'Simulated linked audio receive',!liveMode ? Boolean(demoRx) : liveActivity.status === 'online' ? liveActivity.active.length > 0 : null],
    ['radioCos','Local receiver keying',liveActivity.cos]
  ];
  for (const [id,label,keyed] of indicators) {
    const indicator = byId(id);
    const status = keyed === true ? 'active' : keyed === false ? 'idle' : 'unavailable';
    indicator.dataset.state = status;
    indicator.title = label + ' · ' + status;
    indicator.setAttribute('aria-label',indicator.title);
  }
}

let callerTransmission;
let callerFeedAvailable = false;
const callerStations = new Map();
const countryNames = new Intl.DisplayNames(undefined,{type:'region'});
const callerFlag = byId('callerFlag');
callerFlag.onerror = () => { byId('callerCountry').hidden = true; };
const callerTime = new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'medium'});

function updateCaller(activity) {
  callerFeedAvailable = activity.status === 'online';
  const sources = callerFeedAvailable ? activity.active ?? [] : [];
  const now = Date.now();
  const peer = sources.includes(callerTransmission?.peer) ? callerTransmission.peer : sources[0];
  const source = peer ? 'network' : activity.cos === true ? 'local' : null;
  if (source && (callerTransmission?.source !== source || callerTransmission.peer !== peer || callerTransmission.ended)) {
    callerTransmission = {source,peer,started:now,lastSeen:now};
  }
  if (source) callerTransmission.lastSeen = now;
  else if (callerTransmission && !callerTransmission.ended) callerTransmission.ended = callerTransmission.lastSeen;
  byId('callerTarget').textContent = activity.node ?? byId('callerTarget').textContent;
  const additional = sources.filter(node => node !== peer);
  byId('callerAdditional').hidden = !additional.length;
  byId('callerAdditional').textContent = 'Also active: ' + additional.join(', ');
  if (liveMode && peer && /^[0-9]{3,10}$/.test(peer) &&
      (callerStations.get(peer)?.retryAt ?? 0) <= now) {
    callerStations.set(peer,{...callerStations.get(peer),retryAt:now + 60000});
    fetchJson('api/station-locations?nodes=' + peer).then(data => {
      const info = data.stations?.[peer];
      if (info) callerStations.set(peer,{...info,retryAt:Date.now()+900000});
      renderCaller();
    }).catch(() => {});
  }
  renderCaller();
}

function renderCaller() {
  const transmission = callerTransmission;
  const active = transmission && !transmission.ended;
  const info = liveMode ? callerStations.get(transmission?.peer) : stations[transmission?.peer];
  const callsign = info?.callsign || info?.call;
  const peer = transmission?.peer;
  byId('callerDisplay').dataset.active = String(Boolean(active));
  byId('callerState').textContent = !callerFeedAvailable ? 'Activity feed unavailable' :
    active ? 'Receiving' : transmission ? 'Last heard' : 'Waiting for activity';
  byId('callerIdentity').textContent = callsign || (peer ? 'Node ' + peer : transmission ? 'Local receiver' : '—');
  byId('callerLocation').textContent = [callsign && peer ? 'Node ' + peer : '',info?.location || info?.city,info?.description].filter(Boolean).join(' · ');
  const country = liveMode ? info?.country : info?.coords ? 'us' : null;
  const flagPath = /^[a-z]{2}$/.test(country ?? '') ? 'flags/' + country + '.svg' : null;
  if (flagPath !== callerFlag.getAttribute('src')) {
    byId('callerCountry').hidden = !flagPath;
    if (flagPath) {
      const name = countryNames.of(country.toUpperCase());
      byId('callerCountryName').textContent = name;
      callerFlag.src = flagPath;
    } else callerFlag.removeAttribute('src');
  }
  byId('callerSource').textContent = transmission?.source === 'network' ? 'AllStarLink network' : transmission ? 'Local COS' : '—';
  byId('callerDuration').textContent = transmission ?
    Math.round(((transmission.ended ?? Date.now()) - transmission.started)/1000) + ' s' : '—';
  byId('callerLastHeard').textContent = transmission ? callerTime.format(transmission.lastSeen) : '—';
}

function showCaller() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.palette = state.palette;
  document.querySelector('.mast').hidden = true;
  byId('dashboard').hidden = true;
  byId('caller').hidden = false;
  document.title = 'Live Caller · Crusader Comm/Link';
  const url = new URL(location.href);
  url.searchParams.delete('view');
  byId('callerDashboard').href = url;
  if (liveMode) refreshActivity();
  else {
    const refreshDemo = () => {
      state = read();
      const tx = activeTx();
      updateCaller({status:'online',node:'61000 (demo)',active:tx ? [tx.id] : []});
    };
    refreshDemo();
    setInterval(refreshDemo,250);
  }
}

byId('openCaller').onclick = () => {
  const url = new URL(location.href);
  for (const key of ['configure','panel','peer']) url.searchParams.delete(key);
  url.searchParams.set('view','caller');
  const popup = window.open(url,'crusader-live-caller','popup,width=1000,height=620');
  if (popup) popup.focus();
  else location.assign(url);
};

async function refreshActivity() {
  try { liveActivity = await fetchJson('api/activity'); }
  catch { liveActivity = {status:'unavailable',active:[]}; }
  if (callerOnly) updateCaller(liveActivity);
  else {
    renderRadioIndicators();
    renderLiveMap();
    renderLiveLinks();
  }
  if (liveActivity.status !== 'disabled') setTimeout(refreshActivity,750);
}

const stationTools = byId('stationTools');
let stationToolBusy = false;
async function runStationTool(work) {
  if (stationToolBusy) return;
  stationToolBusy = true;
  const status = byId('stationToolStatus');
  const output = byId('stationToolOutput');
  status.textContent = 'Working…';
  output.hidden = true;
  try {
    const result = await work();
    status.textContent = result.message ?? '';
    output.hidden = !result.output;
    output.textContent = result.output ?? '';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    stationToolBusy = false;
  }
}
function setStationInfoLinks(node) {
  for (const [id,suffix] of [['stationNodeInfo',''],['stationBubbleChart','/networkMap']]) {
    const link = byId(id);
    link.hidden = !/^[0-9]{3,10}$/.test(node ?? '');
    if (!link.hidden) link.href = 'https://stats.allstarlink.org/stats/' + node + suffix;
  }
}
byId('openTools').onclick = () => {
  const node = chosenPeer() || liveSnapshot.node;
  byId('stationLookupNode').value = node ?? '';
  setStationInfoLinks(node);
  stationTools.showModal();
};
byId('stationLookupNode').oninput = event => setStationInfoLinks(event.target.value.trim());
byId('openLinkMap').onclick = () => document.querySelector('[data-pop="map"]').click();
async function readStationTool(path) {
  const response = await fetch(path,{signal:AbortSignal.timeout(12000)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.message);
  return result;
}
byId('stationLookup').onsubmit = event => {
  event.preventDefault();
  const node = byId('stationLookupNode').value.trim();
  runStationTool(async () => {
    const {stations,status} = await readStationTool('api/station-locations?nodes=' + encodeURIComponent(node));
    const station = stations?.[node];
    return station ? {output:[node,station.callsign,station.location,station.description].filter(Boolean).join(' · ')} :
      {message:status === 'unavailable' ? 'AllStarLink directory unavailable.' : 'No published listing for node ' + node + '.'};
  });
};
for (const button of stationTools.querySelectorAll('[data-report]')) {
  button.onclick = () => runStationTool(() => readStationTool('api/local-report?report=' + button.dataset.report));
}
let openedStationConfig;
const stationConfig = byId('stationConfigFile');
const stationConfigText = byId('stationConfigText');
const saveStationConfig = byId('saveStationConfig');
function clearStationConfig() {
  openedStationConfig = null;
  stationConfigText.value = '';
  stationConfigText.disabled = true;
  saveStationConfig.disabled = true;
}
stationTools.addEventListener('close',clearStationConfig);
byId('openEditor').onclick = () => { byId('stationEditor').hidden = false; stationConfig.focus(); };
stationConfig.onchange = clearStationConfig;
byId('loadStationConfig').onclick = () => runStationTool(async () => {
  const file = stationConfig.value;
  clearStationConfig();
  const result = await readStationTool('api/asterisk-config?file=' + encodeURIComponent(file));
  if (stationConfig.value !== file || !stationTools.open) return {};
  openedStationConfig = {file,revision:result.revision};
  stationConfigText.value = result.text;
  stationConfigText.disabled = false;
  saveStationConfig.disabled = false;
  return {message:'Opened ' + file + '.'};
});
byId('stationEditor').onsubmit = event => {
  event.preventDefault();
  const opened = openedStationConfig;
  if (!opened || !window.confirm('Save changes to ' + opened.file + '?')) return;
  runStationTool(async () => {
    const result = await postJson('api/asterisk-config',{...opened,text:stationConfigText.value});
    if (openedStationConfig === opened) opened.revision = result.revision;
    return result;
  });
};
byId('stationDtmf').onsubmit = event => {
  event.preventDefault();
  const digits = byId('stationDigits').value.toUpperCase();
  if (window.confirm('Send DTMF ' + digits + ' on the local node?')) {
    runStationTool(() => postJson('api/station-action',{action:'dtmf',digits}));
  }
};
for (const button of stationTools.querySelectorAll('[data-station-action]')) {
  button.onclick = () => {
    if (window.confirm(button.textContent + ' on the local node?')) {
      runStationTool(() => postJson('api/station-action',{action:button.dataset.stationAction}));
    }
  };
}

async function postJson(path, data) {
  const response = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.message);
  return result;
}

function setBrandLogo(custom) {
  const logo = byId('brandLogo');
  const glyph = byId('brandGlyph');
  const bundled = 'crusader-logo.png';
  logo.onload = () => {
    logo.hidden = false;
    glyph.hidden = true;
  };
  logo.onerror = () => {
    logo.hidden = true;
    glyph.hidden = false;
    if (logo.getAttribute('src') !== bundled) logo.src = bundled;
  };
  logo.src = custom ? 'api/logo?' + Date.now() : bundled;
}

async function listAccounts() {
  const {users} = await fetchJson('api/users');
  byId('accountList').replaceChildren(...users.map(user => {
    const item = document.createElement('li');
    item.textContent = user.name + ' · ' + user.role;
    return item;
  }));
}

let landingAppearance = {text:'',font:'oxanium',assets:[]};
const landingFonts = {oxanium:'Oxanium, system-ui, sans-serif',system:'system-ui, sans-serif',serif:'Georgia, serif',mono:'monospace'};
const landingAssets = [
  ['foreground','landingForegroundFile','landingForegroundRemove'],
  ['background','landingBackgroundFile','landingBackgroundRemove'],
  ['fontFile','landingFontFile','landingFontRemove']
];

function renderLanding() {
  const {text,font,assets} = landingAppearance;
  const welcome = byId('landingWelcome');
  welcome.textContent = text;
  welcome.hidden = !text;
  const image = byId('landingForeground');
  image.hidden = !assets.includes('foreground');
  if (!image.hidden) image.src = 'api/landing/foreground';
  if (assets.includes('background')) document.body.style.setProperty('--landing-background','url("api/landing/background")');
  const landing = byId('landing');
  landing.style.setProperty('--landing-font',landingFonts[font] ?? landingFonts.oxanium);
  if (font === 'custom' && assets.includes('font') && typeof FontFace !== 'undefined') {
    new FontFace('Crusader Landing','url("api/landing/font")').load().then(face => {
      document.fonts.add(face);
      landing.style.setProperty('--landing-font','"Crusader Landing", ' + landingFonts.oxanium);
    }).catch(() => {});
  }
}

function openLandingEditor() {
  byId('landingForm').reset();
  byId('landingText').value = landingAppearance.text;
  byId('landingFont').value = landingAppearance.font;
  for (const [key,,remove] of landingAssets) byId(remove).disabled = !landingAppearance.assets.includes(key === 'fontFile' ? 'font' : key);
}

async function encodeLandingAsset(key, file) {
  if (key === 'fontFile') {
    if (file.size > 2000000 || !/\.(woff2?|ttf|otf)$/i.test(file.name)) throw new Error('Choose a supported font up to 2 MB.');
    const bytes = await file.arrayBuffer();
    await new FontFace('Crusader font preview',bytes).load();
    return new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Could not read the font file.'));
      reader.readAsDataURL(file);
    });
  }
  if (file.size > 5000000 || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('Choose a supported image up to 5 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const foreground = key === 'foreground';
    const scale = Math.min(1,1280 / bitmap.width,900 / bitmap.height);
    canvas.width = foreground ? 640 : Math.max(1,Math.round(bitmap.width * scale));
    canvas.height = foreground ? 640 : Math.max(1,Math.round(bitmap.height * scale));
    const fit = Math.min(canvas.width / bitmap.width,canvas.height / bitmap.height);
    const width = bitmap.width * fit, height = bitmap.height * fit;
    canvas.getContext('2d').drawImage(bitmap,(canvas.width-width)/2,(canvas.height-height)/2,width,height);
    return canvas.toDataURL(foreground ? 'image/png' : 'image/jpeg',.85).split(',')[1];
  } finally { bitmap.close(); }
}

byId('landingForm').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const status = byId('landingAdminStatus');
  button.disabled = true;
  try {
    const request = {text:byId('landingText').value,font:byId('landingFont').value};
    for (const [key,input,remove] of landingAssets) {
      const file = byId(input).files[0];
      if (file) request[key] = await encodeLandingAsset(key,file);
      else if (byId(remove).checked) request[key] = null;
    }
    await postJson('api/landing',request);
    landingAppearance = (await fetchJson('api/session')).landing;
    openLandingEditor();
    status.textContent = 'Saved. Changes appear on the next visit to the landing page.';
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
};

byId('administration').onclick = async () => {
  openLandingEditor();
  byId('adminDialog').showModal();
  try { await listAccounts(); }
  catch (error) { byId('adminStatus').textContent = error.message; }
};
byId('accountForm').onsubmit = async event => {
  event.preventDefault();
  const name = byId('accountName').value;
  try {
    await postJson('api/users',{name,role:byId('accountRole').value,password:byId('accountPassword').value});
    byId('accountForm').reset();
    if (name === account.name) { location.reload(); return; }
    await listAccounts();
    byId('adminStatus').textContent = 'Account saved.';
  } catch (error) { byId('adminStatus').textContent = error.message; }
};
async function saveLogo(image) {
  await postJson('api/logo',{image});
  setBrandLogo(Boolean(image));
  byId('adminStatus').textContent = image ? 'Station logo updated.' : 'Default logo restored.';
}
byId('logoForm').onsubmit = async event => {
  event.preventDefault();
  try {
    const file = byId('logoFile').files[0];
    if (!file || file.size > 1048576 || !['image/png','image/jpeg','image/webp'].includes(file.type)) {
      throw new Error('Choose a PNG, JPEG, or WebP no larger than 1 MB.');
    }
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const scale = 256 / Math.max(bitmap.width,bitmap.height);
    const width = bitmap.width * scale, height = bitmap.height * scale;
    canvas.getContext('2d').drawImage(bitmap,(256-width)/2,(256-height)/2,width,height);
    bitmap.close();
    await saveLogo(canvas.toDataURL('image/png').split(',')[1]);
    byId('logoForm').reset();
  } catch (error) { byId('adminStatus').textContent = error.message; }
};
byId('resetLogo').onclick = async () => {
  try { await saveLogo(null); }
  catch (error) { byId('adminStatus').textContent = error.message; }
};
byId('signIn').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    await postJson('api/login',{name:byId('signInName').value,password:byId('signInPassword').value});
    location.reload();
  } catch (error) {
    byId('signInStatus').textContent = error.message;
    byId('signInPassword').value = '';
  } finally { button.disabled = false; }
};
byId('signOut').onclick = async () => {
  try { await postJson('api/logout',{}); location.reload(); }
  catch (error) { byId('liveCommandStatus').textContent = error.message; }
};

async function startLive() {
  try {
    const session = await fetchJson('api/session');
    account = session.account;
    if (session.landing) landingAppearance = session.landing;
    setBrandLogo(session.logo);
  } catch {
    byId('signInStatus').textContent = 'Local dashboard server unavailable.';
  }
  if (!account) {
    document.body.classList.add('landing-visible');
    renderLanding();
    byId('landing').hidden = false;
    byId('signInName').focus();
    return;
  }
  document.documentElement.classList.remove('session-pending');
  if (callerOnly) { showCaller(); return; }
  if (account.role === 'Observer') document.body.classList.add('observer');
  byId('signOut').hidden = false;
  byId('openTools').hidden = false;
  byId('operatorTools').hidden = account.role === 'Observer';
  byId('localAdminTools').hidden = account.role !== 'Administrator';
  byId('openLocal').hidden = true;
  byId('administration').hidden = account.role !== 'Administrator';
  for (const id of ['connect','feedback','simulate','txLegend']) byId(id).hidden = true;
  byId('linkMap').setAttribute('aria-label','Map of live AllStarLink station connections');
  linkMap.setView([25,0],2);
  byId('liveStatus').hidden = false;
  const selectedPeer = new URLSearchParams(location.search).get('peer');
  if (selectedPeer && /^[1-9][0-9]{2,9}$/.test(selectedPeer)) {
    byId('livePeerEntry').value = selectedPeer;
    byId('liveAction').value = 'disconnect';
  }
  render();
  showConfiguration();
  refreshLiveLinks();
  renderRadioIndicators();
  refreshActivity();
  refreshSkywarn();
  setInterval(refreshSkywarn,30000);
  setInterval(() => refreshWatchWeather(true),300000);
  setInterval(() => refreshNews(true),180000);
}
byId('tickerPause').onclick = () => update({tickerPaused:!state.tickerPaused});
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (!tickerHovered && !tickerFocused && byId('tickerItems').classList.contains('ticker-scroll')) showTickerItem();
  }).observe(byId('tickerItems').parentElement);
}
document.fonts?.ready.then(() => {
  if (!tickerHovered && !tickerFocused && byId('tickerItems').classList.contains('ticker-scroll')) showTickerItem();
});
byId('tickerPrevious').onclick = () => stepTicker(-1);
byId('tickerNext').onclick = () => stepTicker(1);
if (liveMode) startLive();
else if (callerOnly) showCaller();
else {
  setBrandLogo(false);
  render();
  refreshSkywarn();
  setInterval(refreshSkywarn,30000);
  setInterval(() => refreshWatchWeather(true),300000);
  if (!panelOnly || detached === 'map') fitNetwork();
  showConfiguration();
}
