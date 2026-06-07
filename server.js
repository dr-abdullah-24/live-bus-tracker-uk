require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const AdmZip = require('adm-zip');
const path = require('path');

// Ticket type codes embedded in NeTEx filenames → human-readable labels
const TICKET_LABELS = {
    ADSGL:          'Adult Single',
    ADSGLREF:       'Adult Single (ref)',
    CHSGL:          'Child Single',
    CHSGLREF:       'Child Single (ref)',
    CHSGLIGO:       'Child Single (App)',
    ADRTN:          'Adult Return',
    ADRTNKNOWLEDGE: 'Adult Return',
    CHRTN:          'Child Return',
    '1Day':         'Day Ticket',
    '3Day':         '3-Day Pass',
    '7Day':         '7-Day Pass',
    '1Week':        'Weekly Pass',
    '4Week':        '4-Week Pass',
    '1Month':       'Monthly Pass',
    '1Return':      'Return Ticket',
    '1OneWay':      'Network Single',
};
const LABEL_ORDER = ['ADSGL','CHSGL','ADRTN','ADRTNKNOWLEDGE','CHRTN','1Return','1OneWay','1Day','3Day','7Day','1Week','4Week','1Month','ADSGLREF','CHSGLREF','CHSGLIGO'];

// Cache: operator NOC / dataset ID → { data, ts }  (2-hour TTL)
const farePriceCache = new Map();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BODS_API_KEY;
const BODS_BASE = 'https://data.bus-data.dft.gov.uk/api/v1';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// NOC code → full operator name, populated on startup
const operatorCache = new Map();

async function preloadOperators() {
    // Operator names live on the dataset endpoint (operatorName + noc fields)
    let nextUrl = `${BODS_BASE}/dataset/?limit=100&status=published`;
    let pages = 0;
    try {
        while (nextUrl && pages < 30) {
            const res = await axios.get(nextUrl, {
                headers: { Authorization: `Token ${API_KEY}` },
                timeout: 15000,
            });
            (res.data?.results || []).forEach(ds => {
                const name = ds.operatorName;
                const nocs = Array.isArray(ds.noc) ? ds.noc : ds.noc ? [ds.noc] : [];
                if (name) nocs.forEach(n => { if (!operatorCache.has(n)) operatorCache.set(n, name); });
            });
            nextUrl = res.data?.next || null;
            pages++;
        }
        console.log(`Operators cached: ${operatorCache.size}`);
    } catch (err) {
        console.warn('Operator preload failed (NOC codes will show instead of names):', err.message);
    }
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractVehicles(delivery) {
    const raw = delivery?.VehicleActivity;
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map(v => {
        const j = v?.MonitoredVehicleJourney || {};
        const loc = j?.VehicleLocation || {};
        const noc = j.OperatorRef;
        return {
            vehicleRef: j.VehicleRef,
            lineRef: j.LineRef,
            lineName: j.PublishedLineName,
            operatorRef: noc,
            operatorName: operatorCache.get(noc) || noc,
            origin: j.OriginName,
            destination: j.DestinationName,
            lat: parseFloat(loc.Latitude),
            lon: parseFloat(loc.Longitude),
            bearing: parseFloat(j.Bearing) || 0,
            speed: parseFloat(j.Velocity) || 0,
            occupancy: j.OccupancyStatus,
            recordedAt: v.RecordedAtTime,
        };
    }).filter(v => !isNaN(v.lat) && !isNaN(v.lon));
}

async function fetchVehiclesFromBODS(params) {
    const response = await axios.get(`${BODS_BASE}/datafeed/`, {
        headers: { Authorization: `Token ${API_KEY}` },
        params,
        timeout: 20000,
    });
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
    const parsed = await parser.parseStringPromise(response.data);
    const delivery = parsed?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery;
    return extractVehicles(delivery);
}

// Live vehicle positions within a bounding box
app.get('/api/vehicles', async (req, res) => {
    try {
        const { bbox, line, operator } = req.query;
        const params = {};
        if (bbox) params.boundingBox = bbox;
        if (line) params.lineRef = line;
        if (operator) params.operatorRef = operator;

        const vehicles = await fetchVehiclesFromBODS(params);
        res.json({ vehicles, count: vehicles.length, timestamp: new Date().toISOString() });
    } catch (err) {
        console.error('Vehicle fetch error:', err.message);
        res.status(500).json({ error: 'Failed to fetch vehicle data', details: err.message });
    }
});

// Geocode via Nominatim
app.get('/api/geocode', async (req, res) => {
    try {
        const { q, limit = 5 } = req.query;
        const response = await axios.get('https://nominatim.openstreetmap.org/search', {
            params: { q, format: 'json', countrycodes: 'gb', limit, addressdetails: 1 },
            headers: { 'User-Agent': 'LiveBusTrackerUK/1.0 (ah.msee21seecs@seecs.edu.pk)' },
            timeout: 8000,
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route planner: score and rank live vehicles between origin and destination
app.get('/api/route-plan', async (req, res) => {
    try {
        const { originLat, originLon, destLat, destLon, destName } = req.query;
        const oLat = parseFloat(originLat), oLon = parseFloat(originLon);
        const dLat = parseFloat(destLat), dLon = parseFloat(destLon);

        const pad = 0.15;
        const bbox = [
            Math.min(oLon, dLon) - pad,
            Math.min(oLat, dLat) - pad,
            Math.max(oLon, dLon) + pad,
            Math.max(oLat, dLat) + pad,
        ].join(',');

        const vehicles = await fetchVehiclesFromBODS({ boundingBox: bbox });
        const destWords = (destName || '').toLowerCase().split(/[\s,]+/).filter(Boolean);

        const scored = vehicles.map(v => {
            const distOrigin = haversineKm(v.lat, v.lon, oLat, oLon);
            const vDest = (v.destination || '').toLowerCase();
            const vOrig = (v.origin || '').toLowerCase();
            const textScore = destWords.filter(w => w.length > 2 && (vDest.includes(w) || vOrig.includes(w))).length;
            const nearOrigin = distOrigin < 5 ? 2 : distOrigin < 15 ? 1 : 0;
            const idealBearing = (Math.atan2(dLon - oLon, dLat - oLat) * 180 / Math.PI + 360) % 360;
            const diff = Math.abs(v.bearing - idealBearing);
            const bearingScore = (diff < 60 || diff > 300) ? 1 : 0;
            return { ...v, distFromOrigin: distOrigin, score: nearOrigin + textScore * 2 + bearingScore };
        }).filter(v => v.score > 0).sort((a, b) => b.score - a.score);

        const seen = new Set();
        const routes = scored.filter(v => {
            const key = `${v.lineRef}|${v.operatorRef}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, 12);

        res.json({ routes, totalVehicles: vehicles.length });
    } catch (err) {
        console.error('Route plan error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Actual fare prices parsed from NeTEx ZIP for an operator (NOC code)
app.get('/api/fare-prices', async (req, res) => {
    const { noc } = req.query;
    if (!noc) return res.status(400).json({ error: 'noc required' });

    const cached = farePriceCache.get(noc);
    if (cached && Date.now() - cached.ts < 2 * 60 * 60 * 1000) return res.json(cached.data);

    try {
        // Find fare datasets for this operator
        const dsResp = await axios.get(`${BODS_BASE}/fares/dataset/`, {
            headers: { Authorization: `Token ${API_KEY}` },
            params: { noc, status: 'published', limit: 10 },
            timeout: 10000,
        });
        const datasets = dsResp.data?.results || [];
        if (!datasets.length) return res.json({ fares: [], note: 'No fare data published for this operator.' });

        // Pick the dataset whose description specifically mentions this NOC
        const best = datasets.find(d => d.description?.includes(`(${noc})`))
                  || datasets.find(d => d.noc?.length === 1)
                  || datasets[0];

        // Check dataset-level cache
        const dsCached = farePriceCache.get(best.id);
        if (dsCached && Date.now() - dsCached.ts < 2 * 60 * 60 * 1000) {
            farePriceCache.set(noc, { data: dsCached.data, ts: dsCached.ts });
            return res.json(dsCached.data);
        }

        // Download the NeTEx ZIP (can be 20-100MB; cached after first fetch)
        const zipResp = await axios.get(best.url, {
            responseType: 'arraybuffer',
            headers: { Authorization: `Token ${API_KEY}` },
            timeout: 90000,
            maxContentLength: 200 * 1024 * 1024,
        });

        const zip = new AdmZip(Buffer.from(zipResp.data));
        const seenTypes = new Set();
        const pricesByType = {};

        for (const entry of zip.getEntries()) {
            // Filename: {NOC}_{Line}_{Dir}_{TicketType}_{...}.xml
            const parts = entry.name.split('_');
            const ticketType = parts[3];
            if (!ticketType || seenTypes.has(ticketType) || !entry.name.endsWith('.xml')) continue;
            seenTypes.add(ticketType);

            const xml = entry.getData().toString('utf8');
            const amounts = [...xml.matchAll(/<Amount>([\d.]+)<\/Amount>/g)]
                .map(m => parseFloat(m[1])).filter(v => v > 0 && v < 500);
            if (!amounts.length) continue;

            const unique = [...new Set(amounts)].sort((a, b) => a - b);
            pricesByType[ticketType] = { min: unique[0], max: unique[unique.length - 1] };
        }

        // Build ordered fare table
        const fares = [
            ...LABEL_ORDER.filter(t => pricesByType[t]).map(t => ({
                label: TICKET_LABELS[t], min: pricesByType[t].min, max: pricesByType[t].max,
            })),
            // Any unknown types not in LABEL_ORDER
            ...Object.entries(pricesByType)
                .filter(([t]) => !LABEL_ORDER.includes(t) && TICKET_LABELS[t])
                .map(([t, v]) => ({ label: TICKET_LABELS[t], min: v.min, max: v.max })),
        ];

        const result = {
            operatorName: best.operatorName || operatorCache.get(noc) || noc,
            description: best.description,
            currency: 'GBP',
            fares,
        };
        farePriceCache.set(noc, { data: result, ts: Date.now() });
        farePriceCache.set(best.id, { data: result, ts: Date.now() });
        res.json(result);
    } catch (err) {
        console.error('Fare price error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Road path between two coordinates via OSRM (approximate driving route)
app.get('/api/route-shape', async (req, res) => {
    try {
        const { originLat, originLon, destLat, destLon } = req.query;
        const coords = `${originLon},${originLat};${destLon},${destLat}`;
        const response = await axios.get(
            `https://router.project-osrm.org/route/v1/driving/${coords}`,
            { params: { overview: 'full', geometries: 'geojson' }, timeout: 10000 }
        );
        const route = response.data.routes?.[0];
        res.json({
            geometry: route?.geometry,
            distanceM: route?.distance,
            durationS: route?.duration,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fares datasets for an operator (NOC code) — returns cleaned-up summary
app.get('/api/fares', async (req, res) => {
    try {
        const { operator } = req.query;
        const params = { status: 'published', limit: 10 };
        if (operator) params.noc = operator;

        const response = await axios.get(`${BODS_BASE}/fares/dataset/`, {
            headers: { Authorization: `Token ${API_KEY}` },
            params,
            timeout: 10000,
        });

        const datasets = (response.data?.results || []).map(f => ({
            id: f.id,
            operatorName: f.operatorName || operatorCache.get(operator) || operator,
            description: f.description || f.name,
            updated: f.modified || f.created || null,
            numOfLines: f.numOfLines,
            numOfFareProducts: f.numOfFareProducts,
            numOfUserTypes: f.numOfUserTypes,
            url: f.url,
        }));

        res.json({ count: response.data.count, datasets });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Operators list (used for search/filter UI if needed)
app.get('/api/operators', async (req, res) => {
    try {
        const { search, limit = 30 } = req.query;
        const params = { limit };
        if (search) params.search = search;
        const response = await axios.get(`${BODS_BASE}/operators/`, {
            headers: { Authorization: `Token ${API_KEY}` },
            params,
            timeout: 10000,
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Live Bus Tracker running at http://localhost:${PORT}`);
    console.log(`BODS API key: ${API_KEY ? 'configured' : 'MISSING - set BODS_API_KEY in .env'}`);
    preloadOperators();
});
