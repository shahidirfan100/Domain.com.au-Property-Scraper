// Domain.com.au Property Scraper - Optimized __NEXT_DATA__/__APOLLO_STATE__ Extraction
import { Actor, log } from 'apify';
import { Dataset, gotScraping } from 'crawlee';
import { firefox } from 'playwright';
import { load as cheerioLoad } from 'cheerio';

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const DOMAIN_BASE = 'https://www.domain.com.au';

// Stealthy User Agents rotation
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

const STEALTHY_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
    'DNT': '1',
    'Referer': DOMAIN_BASE,
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="121", "Google Chrome";v="121"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
};

const ENABLE_BROWSER_FALLBACK = false;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanText = (text) => {
    if (!text) return null;
    return text.replace(/\s+/g, ' ').trim();
};

const ensureAbsoluteUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    return `${DOMAIN_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
};

const isLikelyListingUrl = (url) => {
    if (!url) return false;
    const normalized = ensureAbsoluteUrl(url);
    if (!normalized) return false;
    if (normalized === DOMAIN_BASE || normalized === `${DOMAIN_BASE}/`) return false;

    const lower = normalized.toLowerCase();
    if (lower.includes('/sale/') && lower.includes('?')) return false;
    if (lower.includes('/rent/') && lower.includes('?')) return false;

    return (
        lower.includes('/property/') ||
        lower.includes('/project/') ||
        /-\d{6,}(?:[/?#]|$)/.test(lower)
    );
};

const pickListingHref = (hrefs) => {
    if (!hrefs || hrefs.length === 0) return null;
    const filtered = hrefs.filter((href) => href && !href.startsWith('#'));
    const candidate = filtered.find((href) => {
        const lower = href.toLowerCase();
        if (lower.startsWith('mailto:') || lower.startsWith('tel:')) return false;
        return (
            lower.includes('/property/') ||
            lower.includes('/project/') ||
            /-\d{6,}(?:[/?#]|$)/.test(lower)
        );
    });
    return candidate || filtered[0] || null;
};

const extractPriceFromText = (text) => {
    if (!text) return null;

    const cleanedText = cleanText(text);

    // Handle price ranges like "$500,000-$600,000" or "$500,000 - $600,000"
    const rangeMatch = cleanedText.match(/\$?([\d,]+)\s*(?:-|to)\s*\$?([\d,]+)/i);
    if (rangeMatch) {
        const min = rangeMatch[1].replace(/,/g, '');
        const max = rangeMatch[2].replace(/,/g, '');
        return `$${parseInt(min, 10).toLocaleString()}-$${parseInt(max, 10).toLocaleString()}`;
    }

    // Handle single prices like "$550,000"
    const priceMatch = cleanedText.match(/\$?([\d,]+)/);
    if (priceMatch) {
        const price = priceMatch[1].replace(/,/g, '');
        return `$${parseInt(price, 10).toLocaleString()}`;
    }

    // Contact agent, auction, etc.
    return cleanedText;
};

const extractLandSizeFromText = (text) => {
    if (!text) return null;
    const cleaned = cleanText(text);
    if (!cleaned) return null;
    const match = cleaned.match(/([\d,.]+)\s*(m2|sqm|m²)/i);
    if (match) {
        const value = match[1].replace(/,/g, '');
        return `${value}m2`;
    }
    return null;
};

const parsePropertyFeatures = ($elem) => {
    const features = {
        beds: null,
        baths: null,
        parking: null,
        landSize: null,
    };

    // Try to find features from various selectors
    const featureText = $elem.text();

    // Extract beds
    const bedsMatch = featureText.match(/(\d+)\s*Bed/i);
    if (bedsMatch) features.beds = parseInt(bedsMatch[1], 10);

    // Extract baths
    const bathsMatch = featureText.match(/(\d+)\s*Bath/i);
    if (bathsMatch) features.baths = parseInt(bathsMatch[1], 10);

    // Extract parking
    const parkingMatch = featureText.match(/(\d+)\s*Parking/i);
    if (parkingMatch) features.parking = parseInt(parkingMatch[1], 10);

    // Extract land size
    const landSizeMatch = featureText.match(/([\d,.]+)\s*m/i);
    if (landSizeMatch) {
        features.landSize = `${landSizeMatch[1]}m2`;
    }

    return features;
};

// ============================================================================
// JSON-LD EXTRACTION
// ============================================================================

const extractJsonLd = (html) => {
    const $ = cheerioLoad(html);
    const scripts = $('script[type="application/ld+json"]');
    const jsonLdData = [];

    scripts.each((_, script) => {
        try {
            const content = $(script).html();
            if (content) {
                const data = JSON.parse(content);
                if (Array.isArray(data)) {
                    jsonLdData.push(...data);
                } else {
                    jsonLdData.push(data);
                }
            }
        } catch (e) {
            // Invalid JSON-LD, skip
        }
    });

    return jsonLdData;
};

const parseJsonLdProperty = (jsonLd) => {
    const property = {};

    for (const data of jsonLd) {
        const type = data['@type'];

        if (type === 'RealEstateListing' || type === 'SingleFamilyResidence' ||
            type === 'House' || type === 'Apartment' || type === 'Product') {

            property.name = data.name || property.name;

            if (data.address) {
                property.address = data.address.streetAddress || property.address;
                property.suburb = data.address.addressLocality || property.suburb;
                property.state = data.address.addressRegion || property.state;
                property.postcode = data.address.postalCode || property.postcode;
            }

            if (data.geo) {
                property.latitude = data.geo.latitude;
                property.longitude = data.geo.longitude;
            }

            if (data.offers) {
                const offers = Array.isArray(data.offers) ? data.offers[0] : data.offers;
                property.price = offers.price || offers.priceSpecification?.price;
                property.priceCurrency = offers.priceCurrency;
            }

            if (!property.landSize) {
                const landValue =
                    data.lotSize?.value ||
                    data.lotSize ||
                    data.landSize?.value ||
                    data.landSize ||
                    data.area?.value ||
                    data.area;
                if (landValue) {
                    property.landSize = `${landValue}m2`;
                }
            }

            if (!property.agency) {
                property.agency =
                    data.seller?.name ||
                    data.provider?.name ||
                    data.brand?.name ||
                    data.publisher?.name ||
                    property.agency;
            }

            if (!property.agent) {
                property.agent =
                    data.seller?.employee?.name ||
                    data.provider?.employee?.name ||
                    data.seller?.contactPoint?.name ||
                    data.provider?.contactPoint?.name ||
                    property.agent;
            }

            property.description = data.description || property.description;
            property.numberOfRooms = data.numberOfRooms || property.numberOfRooms;
            property.floorSize = data.floorSize?.value || property.floorSize;
            property.numberOfBedrooms = data.numberOfBedrooms || property.numberOfBedrooms;
            property.numberOfBathroomsTotal = data.numberOfBathroomsTotal || property.numberOfBathroomsTotal;

            if (data.image) {
                property.images = Array.isArray(data.image) ? data.image : [data.image];
            }
        }
    }

    return Object.keys(property).length > 0 ? property : null;
};

// ============================================================================
// JSON API / EMBEDDED STATE EXTRACTION
// ============================================================================

const DEFAULT_PAGE_SIZE = 40;
const MAX_CARD_PARSE = 160;
const DATASET_BATCH_SIZE = 10;

const createStealthHeaders = () => ({
    ...STEALTHY_HEADERS,
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': DOMAIN_BASE,
});

const safeJsonParse = (maybeJson) => {
    if (!maybeJson) return null;
    try {
        return JSON.parse(maybeJson);
    } catch (err) {
        log.debug(`JSON parse failed: ${err.message}`);
        return null;
    }
};

/**
 * Extract __NEXT_DATA__ with __APOLLO_STATE__ - Domain.com.au's primary data source
 * This is the FASTEST method as all data is pre-rendered in the page source
 */
const extractNextDataApolloState = (html) => {
    // Primary method: Extract __NEXT_DATA__ script tag
    const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch?.[1]) {
        const nextData = safeJsonParse(nextDataMatch[1]);
        if (nextData) {
            // Check for __APOLLO_STATE__ in props
            const apolloState = nextData?.props?.pageProps?.__APOLLO_STATE__
                || nextData?.props?.__APOLLO_STATE__
                || nextData?.__APOLLO_STATE__;

            if (apolloState) {
                log.debug('✅ Found __APOLLO_STATE__ in __NEXT_DATA__');
                return { apolloState, nextData };
            }

            // Also check for data directly in pageProps
            if (nextData?.props?.pageProps) {
                log.debug('✅ Found pageProps in __NEXT_DATA__');
                return { nextData, pageProps: nextData.props.pageProps };
            }

            return { nextData };
        }
    }
    return null;
};

/**
 * Extract listings from __APOLLO_STATE__ object
 * Domain.com.au stores listings with keys like "Listing:<id>" or "PropertyListing:<id>"
 */
const extractListingsFromApolloState = (apolloState) => {
    if (!apolloState || typeof apolloState !== 'object') return [];

    const listings = [];
    const listingPatterns = [
        /^Listing:/,
        /^PropertyListing:/,
        /^SearchListing:/,
        /^RentListing:/,
        /^SaleListing:/,
    ];

    for (const [key, value] of Object.entries(apolloState)) {
        // Check if key matches listing pattern
        const isListing = listingPatterns.some(pattern => pattern.test(key));

        if (isListing && value && typeof value === 'object') {
            listings.push(value);
        }
    }

    log.debug(`Found ${listings.length} listings in __APOLLO_STATE__`);
    return listings;
};

/**
 * Fallback: Extract embedded state from other script patterns
 */
const extractEmbeddedState = (html) => {
    // First try the optimized __NEXT_DATA__ extraction
    const nextDataResult = extractNextDataApolloState(html);
    if (nextDataResult) {
        return nextDataResult;
    }

    // Fallback patterns for older page structures
    const patterns = [
        /window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?})\s*;/,
        /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;/,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) {
            const parsed = safeJsonParse(match[1]);
            if (parsed) return { apolloState: parsed };
        }
    }

    return null;
};

const isListingLike = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    return Boolean(
        obj.listingId ||
        obj.listingSlug ||
        obj.id ||
        obj.propertyDetails ||
        obj.address ||
        obj.addressParts ||
        obj.priceDetails ||
        obj.media ||
        obj.url,
    );
};

const locateListingArray = (payload) => {
    const visited = new Set();
    const queue = [payload];

    while (queue.length) {
        const current = queue.shift();
        if (!current) continue;
        if (typeof current === 'object') {
            if (visited.has(current)) continue;
            visited.add(current);
        }

        if (Array.isArray(current)) {
            const listingCandidates = current.filter(isListingLike);
            if (listingCandidates.length > 0) return listingCandidates;
        }

        if (current && typeof current === 'object') {
            for (const value of Object.values(current)) {
                if (value && (typeof value === 'object' || Array.isArray(value))) {
                    queue.push(value);
                }
            }
        }
    }

    return [];
};

const normalizeListingFromJson = (rawListing) => {
    const listing = rawListing?.listing || rawListing;
    if (!listing || typeof listing !== 'object') return null;

    const propertyDetails = listing.propertyDetails || listing.property || listing.details || {};
    const address = listing.address || listing.addressParts || propertyDetails.address || propertyDetails.addressParts || {};
    const advertiser = listing.advertiser || listing.agency || listing.agencyDetails || {};
    const priceDetails = listing.priceDetails || listing.pricing || listing.price || {};
    const geo = listing.geoLocation || listing.geo || listing.location || {};
    const media = listing.media || listing.mediaItems || listing.images || {};

    const urlCandidate =
        listing.url ||
        listing.listingUrl ||
        listing.canonicalUrl ||
        (listing.listingSlug ? ensureAbsoluteUrl(listing.listingSlug) : null);
    const normalizedUrl = ensureAbsoluteUrl(urlCandidate);

    const property = {
        id: String(listing.id || listing.listingId || propertyDetails.id || listing.listingSlug || '') || null,
        url: isLikelyListingUrl(normalizedUrl) ? normalizedUrl : null,
        address: listing.displayAddress || address.displayAddress || address.street || address.streetAddress || null,
        suburb: address.suburb || address.locality || address.suburbName || null,
        state: address.state || address.stateAbbreviation || address.region || null,
        postcode: address.postcode || address.postalCode || null,
        price: extractPriceFromText(
            priceDetails.displayPrice || priceDetails.priceText || priceDetails.price || listing.priceText,
        ),
        propertyType: propertyDetails.propertyType || listing.propertyType || null,
        beds: propertyDetails.bedrooms ?? propertyDetails.beds ?? listing.beds ?? null,
        baths: propertyDetails.bathrooms ?? listing.bathrooms ?? null,
        parking: propertyDetails.carspaces ?? propertyDetails.parkingSpaces ?? listing.carspaces ?? listing.parking ?? null,
        landSize:
            propertyDetails.landArea || propertyDetails.landSize
                ? `${propertyDetails.landArea || propertyDetails.landSize}m2`
                : null,
        imageUrl:
            listing.imageUrl ||
            (Array.isArray(media) ? media[0] : media.images?.[0]?.url || media[0]?.url) ||
            media?.mainImage?.url ||
            null,
        agent: advertiser.contacts?.[0]?.name || advertiser.agent || listing.agent || null,
        agency: advertiser.primaryAgency?.name || advertiser.agencyName || advertiser.name || null,
        latitude: geo.latitude || geo.lat || null,
        longitude: geo.longitude || geo.lon || null,
        isNew: Boolean(listing.isNew || listing.newListing || listing.tags?.includes('new')),
        source: DOMAIN_BASE,
        scrapedAt: new Date().toISOString(),
    };

    if (!property.imageUrl && Array.isArray(media?.images) && media.images.length > 0) {
        property.imageUrl = media.images[0].url || media.images[0];
    }

    if (!property.id && property.url) {
        const idMatch = property.url.match(/(\d{6,})(?:[/?#]|$)/);
        if (idMatch) property.id = idMatch[1];
    }

    return property.url ? property : null;
};

const deriveNextPageUrl = ({ url, currentPage }) => {
    try {
        const parsed = new URL(url);
        const current = currentPage || parseInt(parsed.searchParams.get('page') || '1', 10) || 1;
        parsed.searchParams.set('page', current + 1);
        if (!parsed.searchParams.get('pageSize')) parsed.searchParams.set('pageSize', String(DEFAULT_PAGE_SIZE));
        return parsed.toString();
    } catch (err) {
        log.debug(`Could not derive next page: ${err.message}`);
        return null;
    }
};

const extractTotalResults = (payload) => {
    const candidates = [
        payload?.totalResults,
        payload?.results?.total,
        payload?.data?.total,
        payload?.paging?.total,
        payload?.pagination?.total,
    ];
    return candidates.find((val) => typeof val === 'number') || null;
};

const extractListingsFromJsonPayload = ({ payload, sourceUrl, currentPage }) => {
    const listingsArray = locateListingArray(payload);
    const properties = listingsArray
        .map((item) => normalizeListingFromJson(item))
        .filter((item) => item && item.url);

    const totalResults = extractTotalResults(payload);

    let nextPage = null;
    const pagingCandidates = [payload?.paging, payload?.pagination, payload?.results?.paging, payload?.data?.paging];
    for (const paging of pagingCandidates) {
        if (paging?.next) {
            nextPage = ensureAbsoluteUrl(paging.next);
            break;
        }
        if (paging?.nextPage) {
            nextPage = ensureAbsoluteUrl(paging.nextPage);
            break;
        }
    }

    if (!nextPage && properties.length > 0) {
        nextPage = deriveNextPageUrl({ url: sourceUrl, currentPage });
    }

    return { properties, totalResults, nextPage };
};

const findFirstListingObject = (payload) => {
    const visited = new Set();
    const queue = [payload];

    while (queue.length) {
        const current = queue.shift();
        if (!current) continue;
        if (typeof current === 'object') {
            if (visited.has(current)) continue;
            visited.add(current);
        }

        if (isListingLike(current)) return current;

        if (current && typeof current === 'object') {
            for (const value of Object.values(current)) {
                if (value && (typeof value === 'object' || Array.isArray(value))) {
                    queue.push(value);
                }
            }
        }
    }

    return null;
};

const createJsonApiCandidates = (url, page) => {
    const candidates = new Set();

    try {
        const parsed = new URL(url);
        const params = new URLSearchParams(parsed.search);
        params.set('page', String(page));
        if (!params.get('pageSize')) params.set('pageSize', String(DEFAULT_PAGE_SIZE));

        const listingType =
            params.get('listingType') ||
            (parsed.pathname.toLowerCase().includes('/rent') ? 'Rent' : 'Sale');
        params.set('listingType', listingType);

        const query = params.toString();
        candidates.add(`${DOMAIN_BASE}/srp/api/search?${query}`);
        candidates.add(`${DOMAIN_BASE}/srp/api/listings?${query}`);
        candidates.add(`${DOMAIN_BASE}/map/api/search?${query}`);
    } catch (err) {
        log.debug(`Failed to build API candidates: ${err.message}`);
    }

    return Array.from(candidates);
};

const fetchListingsViaJsonApi = async ({ url, page, proxyConfiguration }) => {
    const apiCandidates = createJsonApiCandidates(url, page);
    for (const apiUrl of apiCandidates) {
        try {
            const response = await gotScraping({
                url: apiUrl,
                headers: createStealthHeaders(),
                responseType: 'text',
                proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl() : undefined,
                retry: {
                    limit: 1,
                    statusCodes: [408, 429, 500, 502, 503, 504],
                },
                timeout: { request: 5000 },
            });

            const payload = safeJsonParse(response.body);
            if (!payload) continue;

            const extracted = extractListingsFromJsonPayload({
                payload,
                sourceUrl: url,
                currentPage: page,
            });

            if (extracted.properties.length > 0) {
                log.debug(`JSON API succeeded via ${apiUrl} with ${extracted.properties.length} listings`);
                return { ...extracted, apiUrl, properties: extracted.properties.map(addMetadata) };
            }
        } catch (err) {
            log.debug(`JSON API candidate failed (${apiUrl}): ${err.message}`);
        }
    }

    return { properties: [], nextPage: null, totalResults: null };
};

const addMetadata = (property) => {
    if (!property) return property;
    if (!property.imageUrl && Array.isArray(property.images) && property.images.length) {
        property.imageUrl = property.images[0];
    }
    property.scrapedAt = property.scrapedAt || new Date().toISOString();
    property.source = property.source || DOMAIN_BASE;
    return property;
};

// ============================================================================
// HTML PARSING METHOD
// ============================================================================

const scrapeListingPage = async ({ url, proxyConfiguration, html = null, currentPage = 1 }) => {
    try {
        log.debug(`Scraping listing page: ${url}`);

        let pageHtml = html;

        if (!pageHtml) {
            const headers = createStealthHeaders();

            const response = await gotScraping({
                url,
                headers,
                proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl() : undefined,
                responseType: 'text',
                retry: {
                    limit: 2,
                    statusCodes: [408, 429, 500, 502, 503, 504],
                },
                timeout: { request: 12000 },
            });

            pageHtml = response.body;
        }

        const $ = cheerioLoad(pageHtml);
        const properties = [];
        let totalResults = null;
        let nextPageCandidate = null;

        // PRIMARY METHOD: Extract from __NEXT_DATA__/__APOLLO_STATE__ (fastest)
        const embeddedState = extractEmbeddedState(pageHtml);
        if (embeddedState) {
            // Try Apollo State extraction first (most reliable)
            if (embeddedState.apolloState) {
                const apolloListings = extractListingsFromApolloState(embeddedState.apolloState);
                if (apolloListings.length > 0) {
                    log.info(`⚡ Found ${apolloListings.length} listings via __APOLLO_STATE__ (fastest method)`);
                    for (const listing of apolloListings) {
                        const normalized = normalizeListingFromJson(listing);
                        if (normalized) {
                            properties.push(addMetadata(normalized));
                        }
                    }
                }
            }

            // If Apollo State didn't yield results, try pageProps or full payload
            if (properties.length === 0) {
                const payload = embeddedState.pageProps || embeddedState.nextData || embeddedState;
                const embeddedResult = extractListingsFromJsonPayload({
                    payload,
                    sourceUrl: url,
                    currentPage,
                });
                if (embeddedResult.properties.length > 0) {
                    log.debug(`Extracted ${embeddedResult.properties.length} listings from pageProps/nextData`);
                    embeddedResult.properties.forEach((p) => properties.push(addMetadata(p)));
                    totalResults = embeddedResult.totalResults || totalResults;
                    nextPageCandidate = embeddedResult.nextPage || nextPageCandidate;
                }
            }
        }

        // Validate we got HTML content
        if (pageHtml.includes('403 Forbidden') || pageHtml.length < 1000) {
            log.warning('⚠️ Possible blocking or incomplete page received');
        }

        // Parse property cards from HTML - multiple selector strategies
        let propertyCards = [];

        // Strategy 1: Try data-testid selectors (newer Domain interface)
        propertyCards = $('[data-testid*="listing-card"]').toArray();
        log.debug(`[Strategy 1] Found ${propertyCards.length} cards with data-testid`);

        // Strategy 2: Try class-based selectors (common pattern)
        if (propertyCards.length === 0) {
            propertyCards = $('article.listing-card, article[class*="listing"], div[class*="property-card"]').toArray();
            log.debug(`[Strategy 2] Found ${propertyCards.length} cards with class selectors`);
        }

        // Strategy 3: Try generic container selectors
        if (propertyCards.length === 0) {
            propertyCards = $('article, [role="listitem"]').toArray();
            log.debug(`[Strategy 3] Found ${propertyCards.length} cards with generic selectors`);
        }

        if (propertyCards.length === 0) {
            log.warning('❌ No property cards found with any selector strategy');
            log.debug(`Page HTML sample: ${pageHtml.substring(0, 500)}`);
        }

        if (propertyCards.length > MAX_CARD_PARSE) {
            propertyCards = propertyCards.slice(0, MAX_CARD_PARSE);
        }

        for (const card of propertyCards) {
            try {
                const $card = $(card);

                const property = {};

                // Extract URL - pick the most likely listing link
                const hrefs = $card
                    .find('a[href]')
                    .map((_, el) => $(el).attr('href'))
                    .get();
                const listingHref = pickListingHref(hrefs);
                property.url = ensureAbsoluteUrl(listingHref);

                if (!isLikelyListingUrl(property.url)) {
                    log.debug('⏭️  Skipping card: no valid listing URL found');
                    continue;
                }

                // Extract ID from URL (if present)
                const idMatch = property.url.match(/(\d{6,})(?:[/?#]|$)/);
                property.id = idMatch ? idMatch[1] : null;

                // Extract address - Strategy: Try multiple selectors
                let addressText = cleanText($card.find('h2').first().text());
                if (!addressText) addressText = cleanText($card.find('[class*="address"]').first().text());
                if (!addressText) addressText = cleanText($card.find('div').eq(0).text());
                property.address = addressText || null;

                // Extract suburb
                const suburbText = cleanText($card.find('[class*="suburb"], [class*="location"]').first().text());
                property.suburb = suburbText || null;

                // Extract price - try multiple selectors
                let priceText = cleanText($card.find('[class*="price"]').first().text());
                if (!priceText) {
                    const allText = $card.text();
                    const priceMatch = allText.match(/\$[\d,]+/);
                    priceText = priceMatch ? priceMatch[0] : null;
                }
                property.price = extractPriceFromText(priceText);

                // Extract property type
                const typeText = cleanText($card.find('[class*="property-type"], [class*="type"]').first().text());
                property.propertyType = typeText || null;

                // Extract features
                const features = parsePropertyFeatures($card);
                property.beds = features.beds;
                property.baths = features.baths;
                property.parking = features.parking;
                property.landSize = features.landSize;

                // Extract agency name from logo alt text
                const agencyImg = $card.find('img[alt*="Logo"], img[class*="logo"]').first();
                const agencyAlt = agencyImg.attr('alt');
                if (agencyAlt) {
                    property.agency = agencyAlt.replace(/Logo for\s*/i, '').trim();
                }

                // Extract agent name
                const agentName = cleanText($card.find('[class*="agent"], [class*="name"]').first().text());
                property.agent = agentName || null;

                // Extract image
                const imgElem = $card.find('img[src*="domain"], img[src*="realestate"]').first();
                property.imageUrl = imgElem.attr('src') || imgElem.attr('data-src') || null;

                // Check if new listing
                const isNew = $card.text().includes('New') || $card.find('[class*="new"], [class*="badge"]').length > 0;
                property.isNew = isNew;

                properties.push(addMetadata(property));
                log.debug(`✅ Extracted property: ${property.address} - $${property.price}`);

            } catch (err) {
                log.warning(`⚠️  Failed to parse property card: ${err.message}`);
            }
        }

        // Try to find pagination info
        let nextPageLink = $('a[aria-label="Go to next page"]').attr('href');
        if (!nextPageLink) nextPageLink = $('a[rel="next"]').attr('href');

        const totalResultsText = cleanText($('[data-testid="summary-header-total-results"]').text());
        const totalMatch = totalResultsText?.match(/([\d,]+)/);
        if (totalMatch) totalResults = totalResults || parseInt(totalMatch[1].replace(/,/g, ''), 10);

        const nextPage = ensureAbsoluteUrl(nextPageCandidate || nextPageLink) || deriveNextPageUrl({ url, currentPage });

        return {
            properties,
            nextPage,
            totalResults,
        };
    } catch (error) {
        log.error(`Failed to scrape listing page: ${error.message}`);
        return { properties: [], nextPage: null, totalResults: null };
    }
};

// ============================================================================
// PLAYWRIGHT BROWSER METHOD
// ============================================================================

const scrapeViaPlaywright = async ({ url, proxyConfiguration, currentPage = 1 }) => {
    let browser;
    let context;

    try {
        log.debug(`Scraping via Playwright: ${url}`);

        // Firefox launch options (more stealthy than Chromium)
        const launchOptions = {
            headless: true,
            // Firefox-specific args for stealth
            firefoxUserPrefs: {
                'dom.webdriver.enabled': false,
                'useAutomationExtension': false,
            },
        };

        if (proxyConfiguration) {
            const proxyUrl = await proxyConfiguration.newUrl();
            launchOptions.proxy = { server: proxyUrl };
        }

        // Use Firefox instead of Chromium for better stealth
        browser = await firefox.launch(launchOptions);
        context = await browser.newContext({
            userAgent: getRandomUserAgent(),
            viewport: { width: 1920, height: 1080 },
            locale: 'en-AU',
        });

        const page = await context.newPage();

        // Navigate to page
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Wait for content to load
        try {
            await page.waitForSelector('[data-testid="listing-card-wrapper"], .css-1qp9106', { timeout: 30000 });
        } catch (e) {
            log.warning('Timeout waiting for property cards, continuing anyway');
        }

        // Scroll to load lazy images
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 300;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        // Get page content
        const html = await page.content();

        await browser.close();

        // Parse with cheerio
        return await scrapeListingPage({ url, proxyConfiguration, html, currentPage });
    } catch (error) {
        log.error(`Playwright scraping failed: ${error.message}`);
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                // Ignore
            }
        }
        return { properties: [], nextPage: null, totalResults: null };
    }
};

// ============================================================================
// DETAIL PAGE SCRAPING
// ============================================================================

const scrapePropertyDetails = async ({ url, proxyConfiguration }) => {
    try {
        log.debug(`Scraping property details: ${url}`);

        const headers = createStealthHeaders();

        let response = null;
        let lastError = null;
        const maxAttempts = 2;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                response = await gotScraping({
                    url,
                    headers,
                    proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl() : undefined,
                    responseType: 'text',
                    retry: {
                        limit: 1,
                        statusCodes: [408, 429, 500, 502, 503, 504],
                    },
                    timeout: { request: 20000 },
                });
                break;
            } catch (err) {
                lastError = err;
                log.debug(`Detail request failed (attempt ${attempt}/${maxAttempts}): ${err.message}`);
            }
        }

        if (!response) {
            const message = lastError ? lastError.message : 'Detail request failed';
            throw new Error(message);
        }

        const $ = cheerioLoad(response.body);
        const details = {};

        // Extract JSON-LD first
        const jsonLdData = extractJsonLd(response.body);
        const jsonLdProperty = parseJsonLdProperty(jsonLdData);

        if (jsonLdProperty) {
            Object.assign(details, jsonLdProperty);
        }

        const embeddedState = extractEmbeddedState(response.body);
        if (embeddedState) {
            const embeddedDetails = extractListingsFromJsonPayload({
                payload: embeddedState,
                sourceUrl: url,
                currentPage: 1,
            });
            if (embeddedDetails.properties.length > 0) {
                Object.assign(details, embeddedDetails.properties[0]);
            } else {
                const embeddedListing = findFirstListingObject(embeddedState);
                if (embeddedListing) {
                    const normalized = normalizeListingFromJson(embeddedListing);
                    if (normalized) Object.assign(details, normalized);
                }
            }
        }

        // Extract description
        const descElem = $('[data-testid="listing-details__description"], [data-testid="listing-summary-description"]');
        details.description = cleanText(descElem.text());

        // Extract full address components
        if (!details.address) {
            details.address = cleanText($('[data-testid="listing-details__summary-title"]').text());
        }

        // Extract property features
        const bedsElem = $('[data-testid="property-features-text-container"]:contains("Bed")');
        const bathsElem = $('[data-testid="property-features-text-container"]:contains("Bath")');
        const parkingElem = $('[data-testid="property-features-text-container"]:contains("Parking")');

        if (bedsElem.length) {
            const bedsMatch = bedsElem.text().match(/(\d+)/);
            if (bedsMatch) details.numberOfBedrooms = parseInt(bedsMatch[1]);
        }
        if (bathsElem.length) {
            const bathsMatch = bathsElem.text().match(/(\d+)/);
            if (bathsMatch) details.numberOfBathroomsTotal = parseInt(bathsMatch[1]);
        }
        if (parkingElem.length) {
            const parkingMatch = parkingElem.text().match(/(\d+)/);
            if (parkingMatch) details.parking = parseInt(parkingMatch[1]);
        }

        // Extract inspection times
        const inspectionTimes = [];
        $('[data-testid="listing-details__inspection-button"]').each((_, elem) => {
            const time = cleanText($(elem).text());
            if (time) inspectionTimes.push(time);
        });
        details.inspectionTimes = inspectionTimes;

        // Extract agent info
        const agentName = cleanText(
            $('[data-testid="listing-details__agent-name"], [data-testid="agent-card__name"], [class*="agent-name"]')
                .first()
                .text(),
        );
        const agencyName = cleanText(
            $('[data-testid="listing-details__agency-name"], [data-testid="agent-card__agency-name"], [class*="agency-name"]')
                .first()
                .text(),
        );

        details.agent = details.agent || agentName;
        details.agency = details.agency || agencyName;

        // Extract all images
        const images = [];
        $('img[src*="domainstatic"]').each((_, img) => {
            const src = $(img).attr('src');
            if (src && !images.includes(src) && !src.includes('logo')) {
                images.push(src);
            }
        });
        details.images = images;

        // Extract property features list
        const featuresList = [];
        $('[data-testid="listing-details__additional-features-listing"] li').each((_, elem) => {
            const feature = cleanText($(elem).text());
            if (feature) featuresList.push(feature);
        });
        details.features = featuresList;

        // Land size
        if (!details.landSize) {
            const landText = cleanText(
                $('[data-testid="property-features-text-container"]:contains("Land"), [data-testid="listing-summary-land-size"]')
                    .first()
                    .text(),
            );
            details.landSize = extractLandSizeFromText(landText);
        }
        if (!details.landSize && details.features?.length) {
            const landFeature = details.features.find((feature) => /m2|sqm|m²/i.test(feature));
            details.landSize = extractLandSizeFromText(landFeature);
        }

        // Latitude/Longitude from meta tags or map data attributes
        if (!details.latitude || !details.longitude) {
            let metaLat = $('meta[property="place:location:latitude"], meta[name="place:location:latitude"]').attr('content');
            let metaLon = $('meta[property="place:location:longitude"], meta[name="place:location:longitude"]').attr('content');
            if (!metaLat || !metaLon) {
                const geoPosition = $('meta[property="geo.position"], meta[name="geo.position"]').attr('content');
                if (geoPosition && geoPosition.includes(';')) {
                    const [lat, lon] = geoPosition.split(';').map((val) => val.trim());
                    metaLat = metaLat || lat;
                    metaLon = metaLon || lon;
                }
            }

            const mapElem = $('[data-testid*="map"], [data-testid*="Map"]').first();
            const dataLat =
                mapElem.attr('data-lat') ||
                mapElem.attr('data-latitude') ||
                mapElem.attr('data-latitude-deg');
            const dataLon =
                mapElem.attr('data-lng') ||
                mapElem.attr('data-longitude') ||
                mapElem.attr('data-lon') ||
                mapElem.attr('data-longitude-deg');
            let latCandidate = metaLat || dataLat;
            let lonCandidate = metaLon || dataLon;

            const dataLocation = mapElem.attr('data-location');
            if ((!latCandidate || !lonCandidate) && dataLocation) {
                const parsed = safeJsonParse(dataLocation);
                latCandidate = latCandidate || parsed?.lat || parsed?.latitude;
                lonCandidate = lonCandidate || parsed?.lng || parsed?.longitude;
            }

            if (!details.latitude && latCandidate) details.latitude = latCandidate;
            if (!details.longitude && lonCandidate) details.longitude = lonCandidate;
        }

        // Extract property type
        const propertyType = cleanText($('[data-testid="listing-summary-property-type"]').text());
        if (propertyType) details.propertyType = propertyType;

        if (details.numberOfBedrooms && !details.beds) details.beds = details.numberOfBedrooms;
        if (details.numberOfBathroomsTotal && !details.baths) details.baths = details.numberOfBathroomsTotal;
        if (details.images?.length && !details.imageUrl) details.imageUrl = details.images[0];
        details.scrapedAt = details.scrapedAt || new Date().toISOString();
        details.source = details.source || DOMAIN_BASE;

        return details;
    } catch (error) {
        log.error(`Failed to scrape property details: ${error.message}`);
        return {};
    }
};

// ============================================================================
// MAIN ACTOR LOGIC
// ============================================================================

Actor.main(async () => {
    const input = await Actor.getInput();

    const {
        startUrl = 'https://www.domain.com.au/sale/?excludeunderoffer=1&sort=dateupdated-desc',
        maxResults = 50,
        maxPages = 5,
        collectDetails = true,
        proxyConfiguration,
        location = null,
        propertyType = null,
        minPrice = null,
        maxPrice = null,
        minBeds = null,
        state = null,
        sortBy = 'dateupdated-desc',
    } = input;

    const proxyConfig = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : null;

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================

    const validatedMaxResults = Math.max(1, Math.min(maxResults || 50, 1000));
    const validatedMaxPages = Math.max(1, Math.min(maxPages || 5, 50));
    const pageEstimate = Math.ceil(validatedMaxResults / Math.max(20, DEFAULT_PAGE_SIZE));
    const pageLimit = Math.min(
        50,
        Math.max(
            validatedMaxPages,
            pageEstimate,
            Math.ceil(validatedMaxResults / 15), // ensure enough pages when dedup/filters drop items
        ),
    );

    if (!startUrl.includes('domain.com.au')) {
        throw new Error('❌ Invalid input: startUrl must be from domain.com.au');
    }

    log.info('✅ Domain.com.au Property Scraper started', {
        startUrl,
        maxResults: validatedMaxResults,
        maxPages: pageLimit,
        collectDetails,
    });

    // Build search URL with filters
    let searchUrl = startUrl;

    if (location || propertyType || minPrice || maxPrice || minBeds || state) {
        let baseUrl = DOMAIN_BASE;

        if (state) {
            baseUrl = `${DOMAIN_BASE}/sale/${state.toLowerCase()}/`;
        } else if (location) {
            baseUrl = `${DOMAIN_BASE}/sale/${location.toLowerCase().replace(/\s+/g, '-')}/`;
        } else {
            baseUrl = `${DOMAIN_BASE}/sale/`;
        }

        const params = new URLSearchParams();

        if (propertyType) {
            const typeMap = {
                'house': 'House',
                'apartment': 'ApartmentUnitFlat',
                'townhouse': 'Townhouse',
                'villa': 'Villa',
                'land': 'VacantLand',
            };
            params.append('ptype', typeMap[propertyType.toLowerCase()] || propertyType);
        }

        if (minPrice && maxPrice) {
            params.append('price', `${minPrice}-${maxPrice}`);
        } else if (minPrice) {
            params.append('price', `${minPrice}-any`);
        } else if (maxPrice) {
            params.append('price', `any-${maxPrice}`);
        }

        if (minBeds) {
            params.append('bedrooms', minBeds);
        }

        params.append('excludeunderoffer', '1');
        params.append('sort', sortBy);

        searchUrl = `${baseUrl}?${params.toString()}`;
    }

    log.info(`🔍 Final search URL: ${searchUrl}`);

    const allProperties = [];
    const seenIds = new Set();
    let currentPage = 1;
    let nextPageUrl = searchUrl;
    let totalResultsCount = null;
    const datasetPusher = createDatasetPusher(DATASET_BATCH_SIZE);
    const maxDetailConcurrency = 3;
    const detailLimiter = collectDetails ? createConcurrencyLimiter(maxDetailConcurrency) : null;
    const detailTasks = [];
    let detailsCollected = 0;

    // Scraping loop
    while (nextPageUrl && allProperties.length < validatedMaxResults && currentPage <= pageLimit) {
        log.info(
            `📄 Page ${currentPage}/${pageLimit} - Collected: ${allProperties.length}/${validatedMaxResults}`,
            { url: nextPageUrl },
        );

        let result = await scrapeListingPage({
            url: nextPageUrl,
            proxyConfiguration: proxyConfig,
            currentPage,
        });

        if ((!result || result.properties.length === 0) && ENABLE_BROWSER_FALLBACK) {
            log.info(`🌐 Attempting Playwright fallback...`);
            result = await scrapeViaPlaywright({
                url: nextPageUrl,
                proxyConfiguration: proxyConfig,
                currentPage,
            });
        }

        if (!result || result.properties.length === 0) {
            log.warning(`❌ No properties found on page ${currentPage}, stopping pagination`);
            break;
        }

        if (!result.nextPage && result.properties.length > 0) {
            result.nextPage = deriveNextPageUrl({ url: nextPageUrl, currentPage });
        }

        if (result.totalResults && !totalResultsCount) {
            totalResultsCount = result.totalResults;
            log.info(`📊 Total available: ${totalResultsCount} properties`);
        }

        // Deduplicate and add properties
        let addedThisPage = 0;
        const newItemsThisPage = [];
        for (const property of result.properties) {
            const dedupeKey = property.id || property.url;
            if (!dedupeKey || seenIds.has(dedupeKey)) continue;

            seenIds.add(dedupeKey);
            const normalized = addMetadata(property);
            allProperties.push(normalized);
            newItemsThisPage.push({ ...normalized });
            addedThisPage++;

            if (collectDetails && detailLimiter) {
                detailTasks.push(
                    detailLimiter(async () => {
                        try {
                            if (!normalized.url || !isLikelyListingUrl(normalized.url)) return;
                            const details = await scrapePropertyDetails({
                                url: normalized.url,
                                proxyConfiguration: proxyConfig,
                            });

                            for (const [key, value] of Object.entries(details)) {
                                if (value && !normalized[key]) normalized[key] = value;
                            }

                            detailsCollected++;
                            datasetPusher.enqueue({ ...addMetadata(normalized) });
                            await sleep(150 + Math.random() * 350);
                        } catch (error) {
                            log.warning(`⚠️  Failed details for ${normalized.url}: ${error.message}`);
                            datasetPusher.enqueue({ ...addMetadata(normalized) });
                        }
                    }),
                );
            }

            if (allProperties.length >= validatedMaxResults) break;
        }

        log.info(`✅ Added ${addedThisPage} unique properties (${allProperties.length}/${validatedMaxResults} total)`);
        if (!collectDetails && newItemsThisPage.length) {
            datasetPusher.enqueue(newItemsThisPage);
        }

        nextPageUrl = result.nextPage;
        currentPage++;

        // Rate limiting: human-like delays
        if (nextPageUrl && allProperties.length < validatedMaxResults) {
            const delay = 500 + Math.random() * 900;
            log.debug(`⏳ Rate limiting: ${Math.round(delay)}ms before next page`);
            await sleep(delay);
        }
    }

    if (collectDetails && allProperties.length > 0) {
        log.info(`📋 Collecting full details for ${allProperties.length} properties...`);
        await Promise.all(detailTasks);
        await datasetPusher.flush();
        log.info(`✅ Details collected for ${detailsCollected}/${allProperties.length} properties`);
    } else {
        await datasetPusher.flush();
    }

    // Final report
    log.info('═'.repeat(70));
    log.info('✅ SCRAPING COMPLETED SUCCESSFULLY');
    log.info('═'.repeat(70));
    log.info(`📊 Properties scraped: ${allProperties.length}/${validatedMaxResults}`);
    log.info(`📄 Pages processed: ${currentPage - 1}/${pageLimit}`);
    log.info(`🎯 Details collected: ${collectDetails ? 'YES' : 'NO'}`);
    log.info(`📈 Total available: ${totalResultsCount || 'Unknown'}`);
    log.info('═'.repeat(70));
});

// ============================================================================
// HELPER: Concurrency Limiter
// ============================================================================

function createConcurrencyLimiter(maxConcurrency) {
    let active = 0;
    const queue = [];

    const next = () => {
        if (active >= maxConcurrency || queue.length === 0) return;

        active++;
        const { task, resolve, reject } = queue.shift();

        task()
            .then(resolve)
            .catch(reject)
            .finally(() => {
                active--;
                next();
            });
    };

    return (task) => new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        next();
    });
}

function createDatasetPusher(batchSize) {
    const size = Math.max(1, batchSize || DATASET_BATCH_SIZE);
    const buffer = [];
    let chain = Promise.resolve();

    const enqueue = (items) => {
        const list = Array.isArray(items) ? items : [items];
        if (!list.length) return;

        chain = chain.then(async () => {
            buffer.push(...list);
            while (buffer.length >= size) {
                const batch = buffer.splice(0, size);
                await Dataset.pushData(batch);
            }
        });
    };

    const flush = async () => {
        await chain;
        while (buffer.length) {
            const batch = buffer.splice(0, size);
            await Dataset.pushData(batch);
        }
    };

    return { enqueue, flush };
}
