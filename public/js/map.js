let _map = null;
let _clusterLayer = null;
let _currentVehicles = [];
let _routePath = null;

function busIcon(bearing, color, opacity) {
    const rot = (bearing - 45 + 360) % 360;
    return L.divIcon({
        className: '',
        html: `<div style="
            width:26px;height:26px;
            background:${color};
            border:2px solid rgba(255,255,255,0.9);
            border-radius:50% 50% 50% 0;
            transform:rotate(${rot}deg);
            box-shadow:0 2px 6px rgba(0,0,0,0.5);
            opacity:${opacity};
            cursor:pointer;
        "></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
    });
}

function vehiclePopupHtml(v) {
    const line = v.lineName || v.lineRef || '?';
    const recorded = v.recordedAt ? new Date(v.recordedAt).toLocaleTimeString() : '—';
    const opLabel = v.operatorName && v.operatorName !== v.operatorRef
        ? `${v.operatorName} (${v.operatorRef})`
        : (v.operatorRef || '—');
    return `
        <div class="bus-popup">
            <div class="popup-line-badge">${line}</div>
            <div class="popup-journey">
                <strong>${v.origin || '?'}</strong>
                <span style="color:var(--accent)"> → </span>
                <strong>${v.destination || '?'}</strong>
            </div>
            <div class="popup-meta">
                <div>Operator: <strong>${opLabel}</strong></div>
                ${v.occupancy ? `<div>Occupancy: <strong>${v.occupancy}</strong></div>` : ''}
            </div>
            <div class="popup-time">Updated: ${recorded}</div>
            <button class="popup-fare-btn" onclick="loadFares('${v.operatorRef}')">View Fares</button>
        </div>`;
}

function initMap() {
    _map = L.map('map', {
        center: [52.4, -1.5],
        zoom: 7,
        preferCanvas: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
    }).addTo(_map);

    _clusterLayer = L.markerClusterGroup({
        maxClusterRadius: 60,
        chunkedLoading: true,
        iconCreateFunction(cluster) {
            const n = cluster.getChildCount();
            const size = n > 100 ? 42 : n > 20 ? 36 : 30;
            return L.divIcon({
                className: '',
                html: `<div style="
                    width:${size}px;height:${size}px;
                    background:#58a6ff;color:#0d1117;
                    border:2px solid #fff;border-radius:50%;
                    display:flex;align-items:center;justify-content:center;
                    font-weight:700;font-size:${size > 36 ? 13 : 11}px;
                    box-shadow:0 2px 8px rgba(88,166,255,0.4);
                ">${n}</div>`,
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
            });
        },
    });
    _map.addLayer(_clusterLayer);

    let moveTimer;
    _map.on('moveend', () => {
        clearTimeout(moveTimer);
        moveTimer = setTimeout(() => window.loadVehicles(), 600);
    });

    return _map;
}

function getMapBbox() {
    if (!_map) return null;
    const b = _map.getBounds();
    return [
        b.getWest().toFixed(4),
        b.getSouth().toFixed(4),
        b.getEast().toFixed(4),
        b.getNorth().toFixed(4),
    ].join(',');
}

/**
 * Render vehicles with three visual states:
 *  - no search active:     all blue, full opacity
 *  - search done:          suggested=amber, unrelated=very dimmed
 *  - route selected:       selected=red, suggested=amber, unrelated=very dimmed
 */
function renderVehicles(vehicles, suggestedRefs, selectedRef) {
    _currentVehicles = vehicles;
    _clusterLayer.clearLayers();

    const suggested = new Set(suggestedRefs || []);
    const hasFilter = suggested.size > 0 || selectedRef;

    vehicles.forEach(v => {
        const key = v.lineRef || v.lineName;
        const isSuggested = suggested.has(key);
        const isSelected = !!selectedRef && key === selectedRef;

        let color, opacity;
        if (!hasFilter) {
            color = '#58a6ff'; opacity = 1;
        } else if (isSelected) {
            color = '#f85149'; opacity = 1;        // red
        } else if (isSuggested) {
            color = '#d29922'; opacity = 0.9;      // amber
        } else {
            color = '#58a6ff'; opacity = 0.1;      // ghost
        }

        const marker = L.marker([v.lat, v.lon], { icon: busIcon(v.bearing, color, opacity) });
        marker.bindPopup(vehiclePopupHtml(v), { maxWidth: 280 });
        _clusterLayer.addLayer(marker);
    });
}

// Draw the road path (GeoJSON LineString from OSRM) for the selected route
function drawRoutePath(geojson) {
    clearRoutePath();
    if (!geojson || !_map) return;
    _routePath = L.geoJSON(geojson, {
        style: {
            color: '#f85149',
            weight: 5,
            opacity: 0.75,
            lineJoin: 'round',
            lineCap: 'round',
        },
    }).addTo(_map);
}

function clearRoutePath() {
    if (_routePath) { _routePath.remove(); _routePath = null; }
}

function panTo(lat, lon, zoom = 13) {
    if (_map) _map.setView([lat, lon], zoom);
}

function addOriginMarker(lat, lon, label) {
    if (window._originMarker) window._originMarker.remove();
    window._originMarker = L.circleMarker([lat, lon], {
        radius: 9, color: '#fff', weight: 2,
        fillColor: '#3fb950', fillOpacity: 1,
    }).bindTooltip(`From: ${label}`, { permanent: false }).addTo(_map);
}

function addDestMarker(lat, lon, label) {
    if (window._destMarker) window._destMarker.remove();
    window._destMarker = L.circleMarker([lat, lon], {
        radius: 9, color: '#fff', weight: 2,
        fillColor: '#f85149', fillOpacity: 1,
    }).bindTooltip(`To: ${label}`, { permanent: false }).addTo(_map);
}

function clearRouteMarkers() {
    if (window._originMarker) { window._originMarker.remove(); window._originMarker = null; }
    if (window._destMarker) { window._destMarker.remove(); window._destMarker = null; }
}
