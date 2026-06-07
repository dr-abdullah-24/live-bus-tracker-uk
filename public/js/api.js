const API = {
    async getVehicles(params = {}) {
        const url = new URL('/api/vehicles', location.origin);
        Object.entries(params).forEach(([k, v]) => v && url.searchParams.set(k, v));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Vehicle API error ${res.status}`);
        return res.json();
    },

    async geocode(q, limit = 5) {
        const url = new URL('/api/geocode', location.origin);
        url.searchParams.set('q', q);
        url.searchParams.set('limit', limit);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Geocode error ${res.status}`);
        return res.json();
    },

    async routePlan(originLat, originLon, destLat, destLon, destName = '') {
        const url = new URL('/api/route-plan', location.origin);
        url.searchParams.set('originLat', originLat);
        url.searchParams.set('originLon', originLon);
        url.searchParams.set('destLat', destLat);
        url.searchParams.set('destLon', destLon);
        url.searchParams.set('destName', destName);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Route plan error ${res.status}`);
        return res.json();
    },

    async getRouteShape(originLat, originLon, destLat, destLon) {
        const url = new URL('/api/route-shape', location.origin);
        url.searchParams.set('originLat', originLat);
        url.searchParams.set('originLon', originLon);
        url.searchParams.set('destLat', destLat);
        url.searchParams.set('destLon', destLon);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Route shape error ${res.status}`);
        return res.json();
    },

    async getFares(operator) {
        const url = new URL('/api/fares', location.origin);
        if (operator) url.searchParams.set('operator', operator);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Fares API error ${res.status}`);
        return res.json();
    },
};
