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
function show(line, start, end, found) {
  drawing.clearLayers();
  L.polyline(line, { color: "#e75fa5", weight: 4 }).addTo(drawing);
  L.marker([start.lat, start.lng]).addTo(drawing).bindPopup("start");
  L.marker([end.lat, end.lng]).addTo(drawing).bindPopup("end");
  map.fitBounds(L.polyline(line).getBounds());

  const list = $("results");
  list.innerHTML = "";

  if (!found.length) {
    list.textContent = "nothing saved within that detour. try 20 min.";
    return;
  }

  for (const p of found) {
    L.circleMarker([p.lat, p.lng], { color: "#111", fillColor: "#ffd1e8", fillOpacity: 1, radius: 8 })
      .addTo(drawing)
      .bindPopup(p.Name + " (+" + Math.round(p.detour) + " min)");

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
    name.textContent = p.Name + " — " + (p.detour < 2 ? "on the way" : "+" + Math.round(p.detour) + " min");

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = [p.Type, p.Area, p["What food"]].filter(Boolean).join(" · ") + " · ";

    const link = document.createElement("a");
    link.href = "https://www.google.com/maps/search/?api=1&query=" + p.lat + "," + p.lng;
    link.target = "_blank";
    link.textContent = "open in maps";
    meta.appendChild(link);

    li.append(box, name, meta);
    list.appendChild(li);
  }
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
