const AERODATABOX_HOST = "aerodatabox.p.rapidapi.com";
const AERODATABOX_BASE = `https://${AERODATABOX_HOST}`;
const AERODATABOX_API_KEY = process.env.AERODATABOX_API_KEY || "";

const now = new Date();
const yesterday = new Date(now);
yesterday.setDate(now.getDate() - 1);
const tomorrow = new Date(now);
tomorrow.setDate(now.getDate() + 1);

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

function mapStatus(status) {
  if (!status) return "scheduled";
  const s = String(status).toLowerCase();
  if (s.includes("departed") || s.includes("arrived") || s.includes("landed")) return "landed";
  if (s.includes("active") || s.includes("en route") || s.includes("airborne")) return "active";
  if (s.includes("delay") || s.includes("late")) return "delayed";
  if (s.includes("cancel")) return "cancelled";
  return "scheduled";
}

function toScheduledIso(value) {
  if (!value) return null;
  const normalized = String(value).replace(" ", "T");
  const dt = new Date(normalized);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString();
}

function deduplicateFlights(flights) {
  const seen = new Map();
  return flights.filter(flight => {
    const time = new Date(flight.scheduledTime);
    time.setMinutes(Math.floor(time.getMinutes() / 2) * 2, 0, 0);
    const key = `${flight.type}-${flight.otherAirportCode}-${time.toISOString()}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

function buildHeaders() {
  return {
    "x-rapidapi-host": AERODATABOX_HOST,
    "x-rapidapi-key": AERODATABOX_API_KEY
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const dt = new Date(value);
  if (!Number.isFinite(dt.getTime())) return null;
  return Math.max(0, dt.getTime() - Date.now());
}

function asStatusError(status, message = `HTTP ${status}`) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function fetchJsonWithRetry(url, headers, maxAttempts = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        return await res.json();
      }

      const status = res.status;
      const retryable = status === 429 || status >= 500;
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));

      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const waitMs = retryAfterMs ?? 10000;

        if (attempt === maxAttempts) {
          const error = asStatusError(429, `HTTP 429`);
          error.retryAfterMs = waitMs;
          throw error;
        }

        await sleep(waitMs + Math.floor(Math.random() * 200));
        continue;
      }

      if (!retryable || attempt === maxAttempts) {
        throw asStatusError(status);
      }

      const backoffMs = retryAfterMs ?? Math.min(8000, 700 * 2 ** (attempt - 1));
      const jitterMs = Math.floor(Math.random() * 220);
      await sleep(backoffMs + jitterMs);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const jitterMs = Math.floor(Math.random() * 220);
      await sleep(Math.min(8000, 700 * 2 ** (attempt - 1)) + jitterMs);
    }
  }

  throw lastError || new Error("Request failed");
}

const DAY_WINDOWS = [
  { from: "00:00", to: "11:59" },
  { from: "12:00", to: "23:59" }
];

function buildDateTimeCandidates(dateText, fromHHMM, toHHMM) {
  return [
    { from: `${dateText}T${fromHHMM}`, to: `${dateText}T${toHHMM}` },
    { from: `${dateText}T${fromHHMM}:00`, to: `${dateText}T${toHHMM}:59` },
    { from: `${dateText}T${fromHHMM}:00Z`, to: `${dateText}T${toHHMM}:59Z` }
  ];
}

function isFutureDate(targetDate) {
  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return target.getTime() > today.getTime();
}

async function fetchFlightsForDate(targetDate) {
  const dateText = formatDate(targetDate);
  const headers = buildHeaders();
  const departures = [];
  const arrivals = [];
  const windowErrors = [];
  let rateLimited = false;

  for (const window of DAY_WINDOWS) {
    const candidates = buildDateTimeCandidates(dateText, window.from, window.to);
    let windowJson = null;
    let lastWindowError = null;

    for (const candidate of candidates) {
      const url = `${AERODATABOX_BASE}/flights/airports/iata/YYZ/${candidate.from}/${candidate.to}`;
      try {
        const candidateJson = await fetchJsonWithRetry(url, headers, 2);
        const dep = Array.isArray(candidateJson?.departures) ? candidateJson.departures : [];
        const arr = Array.isArray(candidateJson?.arrivals) ? candidateJson.arrivals : [];

        // Some datetime formats can return structurally valid but empty payloads.
        // Keep probing candidate formats for the same window before accepting empties.
        if (dep.length === 0 && arr.length === 0) {
          lastWindowError = new Error(`Empty response for ${candidate.from}..${candidate.to}`);
          continue;
        }

        windowJson = candidateJson;
        break;
      } catch (err) {
        lastWindowError = err;
        if (err?.status === 429) {
          rateLimited = true;
          break;
        }
      }
    }

    if (!windowJson) {
      windowErrors.push(lastWindowError || new Error("No valid response"));
      if (rateLimited) {
        break;
      }
      continue;
    }

    departures.push(...(Array.isArray(windowJson?.departures) ? windowJson.departures : []));
    arrivals.push(...(Array.isArray(windowJson?.arrivals) ? windowJson.arrivals : []));
    await sleep(350);
  }

  try {
    if (windowErrors.length === DAY_WINDOWS.length) {
      throw windowErrors[0];
    }

    const mappedDepartures = departures
      .map((flight) => {
        const movementAirport = flight?.movement?.airport || {};
        const movementCountryCode =
          movementAirport?.countryCode ||
          movementAirport?.country?.code ||
          movementAirport?.country?.countryCode ||
          movementAirport?.municipalityCountryCode ||
          null;

        return {
        type: "departure",
        flightNumber: flight?.number || "N/A",
        airline: flight?.airline?.name || flight?.number || "Unknown",
        otherAirport: flight?.movement?.airport?.name || "Unknown",
        otherAirportCode: flight?.movement?.airport?.iata || "N/A",
        departureIata: "YYZ",
        arrivalIata: flight?.movement?.airport?.iata || "",
        departureCountryCode: "CA",
        arrivalCountryCode: movementCountryCode,
        departure: {
          airport: {
            iata: "YYZ",
            countryCode: "CA"
          }
        },
        arrival: {
          airport: {
            iata: flight?.movement?.airport?.iata || "",
            countryCode: movementCountryCode
          }
        },
        scheduledTime: toScheduledIso(flight?.movement?.scheduledTime?.utc) || toScheduledIso(flight?.movement?.scheduledTime?.local),
        status: mapStatus(flight?.status),
        resolvedStatus: mapStatus(flight?.status),
        date: dateText
        };
      })
      .filter((f) => f.scheduledTime);

    const mappedArrivals = arrivals
      .map((flight) => {
        const movementAirport = flight?.movement?.airport || {};
        const movementCountryCode =
          movementAirport?.countryCode ||
          movementAirport?.country?.code ||
          movementAirport?.country?.countryCode ||
          movementAirport?.municipalityCountryCode ||
          null;

        return {
        type: "arrival",
        flightNumber: flight?.number || "N/A",
        airline: flight?.airline?.name || flight?.number || "Unknown",
        otherAirport: flight?.movement?.airport?.name || "Unknown",
        otherAirportCode: flight?.movement?.airport?.iata || "N/A",
        departureIata: flight?.movement?.airport?.iata || "",
        arrivalIata: "YYZ",
        departureCountryCode: movementCountryCode,
        arrivalCountryCode: "CA",
        departure: {
          airport: {
            iata: flight?.movement?.airport?.iata || "",
            countryCode: movementCountryCode
          }
        },
        arrival: {
          airport: {
            iata: "YYZ",
            countryCode: "CA"
          }
        },
        scheduledTime: toScheduledIso(flight?.movement?.scheduledTime?.utc) || toScheduledIso(flight?.movement?.scheduledTime?.local),
        status: mapStatus(flight?.status),
        resolvedStatus: mapStatus(flight?.status),
        date: dateText
        };
      })
      .filter((f) => f.scheduledTime);

    const rawDepartures = mappedDepartures;
    const rawArrivals = mappedArrivals;
    const dedupedDepartures = deduplicateFlights(rawDepartures);
    const dedupedArrivals = deduplicateFlights(rawArrivals);

    process.stderr.write(`Departures before dedup: ${rawDepartures.length}, after: ${dedupedDepartures.length}\n`);
    process.stderr.write(`Arrivals before dedup: ${rawArrivals.length}, after: ${dedupedArrivals.length}\n`);

    return { flights: [...dedupedDepartures, ...dedupedArrivals], error: null };
  } catch (err) {
    if (err?.status === 429) {
      const retryAfterSec = Number.isFinite(err?.retryAfterMs)
        ? Math.max(1, Math.ceil(err.retryAfterMs / 1000))
        : null;
      const msg = retryAfterSec
        ? `Failed for ${dateText}: HTTP 429 (rate limited, retry after ~${retryAfterSec}s)`
        : `Failed for ${dateText}: HTTP 429`;
      process.stderr.write(`AeroDataBox rate limit for ${dateText}: ${msg}\n`);
      return { flights: [], error: msg };
    }

    if (err?.status === 400 && isFutureDate(targetDate)) {
      const msg = `No schedule returned for ${dateText} (future day may not be available on current API plan)`;
      process.stderr.write(`AeroDataBox request skipped for ${dateText}: ${msg}\n`);
      return { flights: [], error: msg };
    }
    process.stderr.write(`AeroDataBox request failed for ${dateText}: ${err.message}\n`);
    return { flights: [], error: `Failed for ${dateText}: ${err.message}` };
  }
}

const dates = {
  yesterday: formatDate(yesterday),
  today: formatDate(now),
  tomorrow: formatDate(tomorrow)
};

if (!AERODATABOX_API_KEY) {
  process.stderr.write("AERODATABOX_API_KEY is not set. Returning empty flights.\n");
  process.stdout.write(
    JSON.stringify({
      flights: [],
      fetchedAt: new Date().toISOString(),
      dates,
      error: "AERODATABOX_API_KEY is not set"
    })
  );
} else {
  const targets = [yesterday, now, tomorrow];
  const results = [];

  for (const [idx, target] of targets.entries()) {
    const result = await fetchFlightsForDate(target);
    results.push(result);
    if (idx < targets.length - 1) {
      await sleep(1200);
    }
  }

  const warnings = results.map((r) => r.error).filter(Boolean);

  let flights = results
    .flatMap((r) => r.flights)
    .sort(
    (a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime)
  );

  let error = null;
  if (flights.length === 0) {
    if (warnings.length > 0 && warnings.every((w) => String(w).includes("HTTP 429"))) {
      error = "All AeroDataBox requests were rate-limited (HTTP 429).";
    } else if (warnings.length > 0) {
      error = "No flights available from API for current build window.";
    } else {
      error = "API returned an empty flight snapshot for this build window.";
    }
  }

  const finalTotalDepartures = flights.filter((f) => f.type === "departure").length;
  const finalTotalArrivals = flights.filter((f) => f.type === "arrival").length;

  process.stdout.write(
    JSON.stringify({
      flights,
      fetchedAt: new Date().toISOString(),
      dates,
      warnings,
      totalDepartures: finalTotalDepartures,
      totalArrivals: finalTotalArrivals,
      source: "live-api",
      ...(error ? { error } : {})
    })
  );
}
