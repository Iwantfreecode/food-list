// ---------- settings ----------
// your "food list" sheet, read as CSV (the sheet must stay shared as "anyone with the link: viewer")
const SHEET_ID = "1-1Xmboyd_65Knd7jcQthWV6rsvK8GhZRWal7xj7FTpM";
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/gviz/tq?tqx=out:csv&sheet=Sheet1";

const PREFILTER_KM = 10; // ignore places farther than this from the route (saves requests)
const OSRM = "https://router.project-osrm.org/route/v1/driving/";

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(text) {
  $("status").textContent = text;
}

// ---------- the map ----------
const map = L.map("map").setView([13.75, 100.6], 9); // starts around Bangkok
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors",
}).addTo(map);
const drawing = L.layerGroup().addTo(map); // everything we draw goes here so we can clear it

// ---------- step 1: turn typed text into coordinates ----------
async function geocode(text) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=th&q=" +
    encodeURIComponent(text);
  const data = await (await fetch(url)).json();
  if (!data.length) throw new Error("can't find: " + text);
  return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
}

// ---------- step 2: get the driving route ----------
async function getRoute(points) {
  // OSRM wants "lng,lat;lng,lat;..."
  const coords = points.map((p) => p.lng + "," + p.lat).join(";");
  const url = OSRM + coords + "?overview=full&geometries=geojson";
  const data = await (await fetch(url)).json();
  if (data.code !== "Ok") throw new Error("no route found");
  const route = data.routes[0];
  return {
    minutes: route.duration / 60,
    // geojson gives [lng, lat]; flip to [lat, lng] for the map
    line: route.geometry.coordinates.map((c) => [c[1], c[0]]),
  };
}

// ---------- step 3: read the places from the sheet ----------
function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function loadPlaces() {
  const text = await (await fetch(SHEET_CSV_URL)).text();
  const [header, ...rows] = parseCSV(text);
  return rows
    .map((r) => Object.fromEntries(header.map((name, i) => [name.trim(), (r[i] || "").trim()])))
    .map((p) => ({ ...p, lat: Number(p.Lat), lng: Number(p.Long) }))
    .filter((p) => p.Name && p.lat && p.lng); // skip rows with no coordinates yet
}

// ---------- step 4: which places are close to the route? ----------
function km(a, b) {
  // straight-line distance between two [lat, lng] points (haversine formula)
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function distanceToRoute(place, line) {
  let best = Infinity;
  for (const point of line) best = Math.min(best, km([place.lat, place.lng], point));
  return best;
}

// ---------- step 5: real detour time for each nearby place ----------
// detour = (start -> place -> end) minus (start -> end)
async function findDetours(start, end, directMinutes, line, places, limit) {
  const nearby = places.filter((p) => distanceToRoute(p, line) <= PREFILTER_KM);
  const found = [];
  for (let i = 0; i < nearby.length; i++) {
    setStatus("checking detours " + (i + 1) + " / " + nearby.length + " ...");
    const via = await getRoute([start, nearby[i], end]);
    const detour = via.minutes - directMinutes;
    if (detour <= limit) found.push({ ...nearby[i], detour: Math.max(0, detour) });
    await sleep(300); // be gentle with the free routing server
  }
  return found.sort((a, b) => a.detour - b.detour);
}

// ---------- step 6: show everything ----------

// one saved place -> one pin on the map + one "[ ]" line in the list
// (both modes use this, so the list looks the same everywhere)
function addItem(p, label) {
  L.circleMarker([p.lat, p.lng], { color: "#111", fillColor: "#ffd1e8", fillOpacity: 1, radius: 8 })
    .addTo(drawing)
    .bindPopup(p.Name + " (" + label + ")");

  const li = document.createElement("li");

  const box = document.createElement("span");
  box.className = "box";
  box.textContent = "[ ] ";
  box.onclick = () => {
    const done = li.classList.toggle("done");
    box.textContent = done ? "[x] " : "[ ] ";
  };

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = p.Name + " — " + label;

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [p.Type, p.Area, p["What food"]].filter(Boolean).join(" · ") + " · ";

  const link = document.createElement("a");
  link.href = "https://www.google.com/maps/search/?api=1&query=" + p.lat + "," + p.lng;
  link.target = "_blank";
  link.textContent = "open in maps";
  meta.appendChild(link);

  li.append(box, name, meta);
  $("results").appendChild(li);
}

function show(line, start, end, found) {
  drawing.clearLayers();
  L.polyline(line, { color: "#e75fa5", weight: 4 }).addTo(drawing);
  L.marker([start.lat, start.lng]).addTo(drawing).bindPopup("start");
  L.marker([end.lat, end.lng]).addTo(drawing).bindPopup("end");
  map.fitBounds(L.polyline(line).getBounds());

  $("list-title").textContent = "on the route";
  $("results").innerHTML = "";

  if (!found.length) {
    $("results").textContent = "nothing saved within that detour. try 20 min.";
    return;
  }
  for (const p of found) addItem(p, p.detour < 2 ? "on the way" : "+" + Math.round(p.detour) + " min");
}

// ---------- the button ----------
$("go").onclick = async () => {
  try {
    const limit = Number(document.querySelector('input[name="limit"]:checked').value);

    setStatus("finding start...");
    const start = await geocode($("start").value);
    await sleep(1100); // the geocoder allows about 1 request per second
    setStatus("finding destination...");
    const end = await geocode($("end").value);

    setStatus("drawing route...");
    const direct = await getRoute([start, end]);

    setStatus("loading saved places...");
    const places = await loadPlaces();

    const found = await findDetours(start, end, direct.minutes, direct.line, places, limit);
    show(direct.line, start, end, found);
    setStatus("trip: " + Math.round(direct.minutes) + " min · found " + found.length + " place(s)");
  } catch (err) {
    setStatus("oops: " + err.message);
  }
};

// =====================================================
// pick-a-spot mode: choose ONE place, see saved food near it
// =====================================================

let spot = null; // the chosen spot {lat, lng}. null = "use whatever is typed in the box"

// three ways to choose the spot: tap the map, type a name, or use my location.
function setSpot(point, label) {
  spot = point;
  $("spot").value = label;
  drawing.clearLayers();
  L.marker([point.lat, point.lng]).addTo(drawing).bindPopup("spot");
}

// 1) tap the map (only counts while "pick a spot" is selected)
map.on("click", (e) => {
  if (currentMode() !== "spot") return;
  setSpot({ lat: e.latlng.lat, lng: e.latlng.lng }, "pin on map");
});

// 2) typing a new name throws away the old pin, so the text wins again
$("spot").oninput = () => { spot = null; };

// 3) "use my location" (the phone asks permission first)
$("here").onclick = () => {
  if (!navigator.geolocation) return setStatus("oops: this browser can't share location");
  setStatus("getting your location...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setSpot({ lat: pos.coords.latitude, lng: pos.coords.longitude }, "my location");
      map.setView([spot.lat, spot.lng], 14);
      setStatus("got it. now press [ find food near here ]");
    },
    () => setStatus("oops: location was blocked. type a place or tap the map instead.")
  );
};

// driving time from the spot to many places in ONE request (OSRM "table" service)
async function driveTimes(from, places) {
  const coords = [from, ...places].map((p) => p.lng + "," + p.lat).join(";");
  const url = "https://router.project-osrm.org/table/v1/driving/" + coords + "?sources=0&annotations=duration";
  const data = await (await fetch(url)).json();
  if (data.code !== "Ok") throw new Error("couldn't get drive times");
  // durations[0][0] is spot -> spot, so place i is at i + 1. seconds -> minutes
  return places.map((p, i) => ({ ...p, minutes: data.durations[0][i + 1] / 60 }));
}

async function findNear(from, places, maxMinutes) {
  // cheap first pass: closest 90 within 25 km in a straight line (the free server limits request size)
  const close = places
    .map((p) => ({ ...p, straight: km([from.lat, from.lng], [p.lat, p.lng]) }))
    .filter((p) => p.straight <= 25)
    .sort((a, b) => a.straight - b.straight)
    .slice(0, 90);
  if (!close.length) return [];

  const timed = await driveTimes(from, close);
  return timed
    .filter((p) => p.minutes <= maxMinutes) // null (no road) becomes 0 here, so skip those too
    .filter((p) => p.minutes > 0 || p.straight < 0.2)
    .sort((a, b) => a.minutes - b.minutes);
}

function showNear(from, found) {
  drawing.clearLayers();
  L.marker([from.lat, from.lng]).addTo(drawing).bindPopup("spot");

  $("list-title").textContent = "near the spot";
  $("results").innerHTML = "";

  if (!found.length) {
    $("results").textContent = "nothing saved that close. try 20 min.";
    map.setView([from.lat, from.lng], 13);
    return;
  }
  for (const p of found) addItem(p, Math.max(1, Math.round(p.minutes)) + " min away");
  map.fitBounds(L.latLngBounds([[from.lat, from.lng], ...found.map((p) => [p.lat, p.lng])]).pad(0.2));
}

$("go-spot").onclick = async () => {
  try {
    const maxMinutes = Number(document.querySelector('input[name="drive"]:checked').value);

    if (!spot) {
      if (!$("spot").value.trim()) throw new Error("type a place, tap the map, or use my location");
      setStatus("finding spot...");
      spot = await geocode($("spot").value);
    }

    setStatus("loading saved places...");
    const places = await loadPlaces();

    setStatus("checking drive times...");
    const found = await findNear(spot, places, maxMinutes);
    showNear(spot, found);
    setStatus("found " + found.length + " place(s) within " + maxMinutes + " min");
  } catch (err) {
    setStatus("oops: " + err.message);
  }
};

// ---------- switch between the two modes ----------
function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function applyMode() {
  const isSpot = currentMode() === "spot";
  $("route-box").hidden = isSpot;
  $("spot-box").hidden = !isSpot;
  setStatus("");
}

for (const radio of document.querySelectorAll('input[name="mode"]')) radio.onchange = applyMode;
applyMode();
