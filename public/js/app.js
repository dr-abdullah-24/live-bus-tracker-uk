let selectedOrigin = null;
let selectedDest = null;
let refreshTimer = null;

// Preserved across auto-refresh so highlighting survives vehicle reload
let lastVehicles = [];
let currentSuggestedRefs = [];
let currentSelectedRef = null;

// ── Initialise ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadVehicles();
    startAutoRefresh();

    document.getElementById('refresh-btn').addEventListener('click', () => loadVehicles(true));
    document.getElementById('search-btn').addEventListener('click', searchRoutes);
    document.getElementById('clear-btn').addEventListener('click', clearSearch);
    document.getElementById('close-fares').addEventListener('click', () => {
        document.getElementById('fares-panel').style.display = 'none';
    });

    setupAutocomplete('origin-input', 'origin-suggestions', place => {
        selectedOrigin = { lat: +place.lat, lon: +place.lon, name: place.display_name };
        document.getElementById('origin-input').value = shortName(place.display_name);
        addOriginMarker(+place.lat, +place.lon, shortName(place.display_name));
        panTo(+place.lat, +place.lon, 13);
    });

    setupAutocomplete('dest-input', 'dest-suggestions', place => {
        selectedDest = { lat: +place.lat, lon: +place.lon, name: place.display_name };
        document.getElementById('dest-input').value = shortName(place.display_name);
        addDestMarker(+place.lat, +place.lon, shortName(place.display_name));
    });
});

// ── Vehicle loading ──────────────────────────────────────────────────────────
window.loadVehicles = async function loadVehicles(manual = false) {
    if (manual) showMapLoading(true);
    try {
        const bbox = getMapBbox();
        const data = await API.getVehicles({ bbox });
        lastVehicles = data.vehicles;
        // Re-render preserving whatever highlight state is active
        renderVehicles(lastVehicles, currentSuggestedRefs, currentSelectedRef);
        document.getElementById('vehicle-count').textContent = `${data.count} buses live`;
        document.getElementById('last-updated').textContent =
            'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
        showError('Could not load live bus data. Check your connection.');
        console.error(err);
    } finally {
        showMapLoading(false);
    }
};

function startAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => loadVehicles(false), 30000);
}

// ── Autocomplete ─────────────────────────────────────────────────────────────
function setupAutocomplete(inputId, listId, onSelect) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    let timer;

    input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < 3) { list.style.display = 'none'; return; }
        timer = setTimeout(async () => {
            try {
                const results = await API.geocode(q);
                renderSuggestions(list, results, place => {
                    onSelect(place);
                    list.style.display = 'none';
                });
            } catch (_) {}
        }, 300);
    });

    document.addEventListener('click', e => {
        if (!input.contains(e.target) && !list.contains(e.target)) {
            list.style.display = 'none';
        }
    });
}

function renderSuggestions(list, results, onSelect) {
    list.innerHTML = '';
    if (!results.length) { list.style.display = 'none'; return; }
    results.slice(0, 6).forEach(place => {
        const li = document.createElement('li');
        li.textContent = place.display_name;
        li.addEventListener('mousedown', e => { e.preventDefault(); onSelect(place); });
        list.appendChild(li);
    });
    list.style.display = 'block';
}

// ── Route planning ────────────────────────────────────────────────────────────
async function searchRoutes() {
    if (!selectedOrigin || !selectedDest) {
        showError('Select both origin and destination from the dropdown suggestions.');
        return;
    }

    const btn = document.getElementById('search-btn');
    btn.disabled = true;
    btn.textContent = 'Searching…';

    try {
        const data = await API.routePlan(
            selectedOrigin.lat, selectedOrigin.lon,
            selectedDest.lat, selectedDest.lon,
            selectedDest.name
        );

        // Highlight all suggested routes on the map (amber), clear any selected path
        currentSuggestedRefs = data.routes.map(r => r.lineRef || r.lineName).filter(Boolean);
        currentSelectedRef = null;
        clearRoutePath();
        renderVehicles(lastVehicles, currentSuggestedRefs, null);

        displayRoutes(data.routes);
    } catch (err) {
        showError('Route search failed. Please try again.');
        console.error(err);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Find Routes';
    }
}

function displayRoutes(routes) {
    const panel = document.getElementById('results-panel');
    const container = document.getElementById('results-container');
    panel.style.display = 'block';

    if (!routes.length) {
        container.innerHTML = `<div class="no-results">
            No buses found between these locations right now.<br>
            Try a broader search or check again in a few minutes.
        </div>`;
        return;
    }

    container.innerHTML = routes.map((r, i) => {
        const opLabel = r.operatorName && r.operatorName !== r.operatorRef
            ? `${esc(r.operatorName)} <span class="op-noc">(${esc(r.operatorRef)})</span>`
            : esc(r.operatorRef || 'Unknown operator');
        return `
        <div class="route-card" id="route-${i}" onclick="selectRoute('${esc(r.lineRef)}', '${esc(r.lineName)}', ${i})">
            <div class="route-header">
                <span class="route-badge">${esc(r.lineName || r.lineRef || 'BUS')}</span>
                <span class="route-operator">${opLabel}</span>
            </div>
            <div class="route-journey">
                <span>${esc(r.origin || '—')}</span>
                <span class="journey-arrow">→</span>
                <span>${esc(r.destination || '—')}</span>
            </div>
            <div class="route-meta">
                <span class="distance-badge">~${r.distFromOrigin?.toFixed(1)} km from origin</span>
                <button class="fare-btn" onclick="loadFares(event, '${esc(r.operatorRef)}')">Fares</button>
            </div>
        </div>`;
    }).join('');
}

// Called when user clicks a route card
window.selectRoute = async function selectRoute(lineRef, lineName, idx) {
    document.querySelectorAll('.route-card').forEach(c => c.classList.remove('active'));
    const card = document.getElementById(`route-${idx}`);
    if (card) card.classList.add('active');

    // Use whichever identifier is valid
    const ref = (lineRef && lineRef !== 'undefined') ? lineRef
              : (lineName && lineName !== 'undefined') ? lineName
              : null;

    currentSelectedRef = ref;
    renderVehicles(lastVehicles, currentSuggestedRefs, ref);

    // Draw road path between origin and destination
    if (selectedOrigin && selectedDest) {
        try {
            const shape = await API.getRouteShape(
                selectedOrigin.lat, selectedOrigin.lon,
                selectedDest.lat, selectedDest.lon
            );
            if (shape.geometry) drawRoutePath(shape.geometry);
        } catch (_) {
            // Path is best-effort; silently skip if OSRM is unavailable
        }
    }
};

// ── Fares ─────────────────────────────────────────────────────────────────────
window.loadFares = async function loadFares(eventOrOperator, operatorRef) {
    let noc;
    if (typeof eventOrOperator === 'string') {
        noc = eventOrOperator;
    } else {
        eventOrOperator.stopPropagation();
        noc = operatorRef;
    }

    if (!noc || noc === 'undefined') {
        showError('No operator code available for this bus.');
        return;
    }

    const panel = document.getElementById('fares-panel');
    const content = document.getElementById('fares-content');
    panel.style.display = 'block';
    content.innerHTML = '<div class="no-fares">Loading fare data…</div>';

    try {
        const data = await API.getFares(noc);
        const results = data.results || [];
        if (!results.length) {
            content.innerHTML = `<p class="no-fares">No published fare datasets for <strong>${esc(noc)}</strong>.</p>`;
            return;
        }
        content.innerHTML = results.map(f => {
            const updated = (f.modified_date || f.published_at)
                ? new Date(f.modified_date || f.published_at).toLocaleDateString('en-GB')
                : 'Unknown';
            return `<div class="fare-item">
                <div class="fare-name">${esc(f.name || 'Fare Dataset')}</div>
                <div class="fare-meta">Operator: <strong>${esc(noc)}</strong> &bull; Updated: ${updated}</div>
                ${f.url ? `<a class="fare-link" href="${esc(f.url)}" target="_blank" rel="noopener">Download NeTEx Fare Data &rarr;</a>` : ''}
            </div>`;
        }).join('');
    } catch (err) {
        content.innerHTML = '<p class="fare-error">Failed to load fare information.</p>';
    }
};

// ── Clear ─────────────────────────────────────────────────────────────────────
function clearSearch() {
    selectedOrigin = null;
    selectedDest = null;
    currentSuggestedRefs = [];
    currentSelectedRef = null;
    document.getElementById('origin-input').value = '';
    document.getElementById('dest-input').value = '';
    document.getElementById('results-panel').style.display = 'none';
    document.getElementById('fares-panel').style.display = 'none';
    clearRouteMarkers();
    clearRoutePath();
    renderVehicles(lastVehicles, [], null);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function shortName(displayName) {
    return displayName.split(',')[0].trim();
}

function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showMapLoading(show) {
    document.getElementById('map-loading').style.display = show ? 'flex' : 'none';
}

function showError(msg) {
    const el = document.getElementById('error-toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.style.display = 'none'), 5000);
}
