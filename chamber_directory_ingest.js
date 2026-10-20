#!/usr/bin/env node

"use strict";

require("dotenv").config();

const cheerio = require("cheerio");
const { Pool } = require("pg");

/* --------------------------------------------------------------------------
 * Configuration
 * ----------------------------------------------------------------------- */

function envFlag(name, fallback = false) {
    const raw = process.env[name];

    if (raw === undefined || raw === null || String(raw).trim() === "") {
        return fallback;
    }

    return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function envInt(name, fallback) {
    const parsed = Number.parseInt(process.env[name] || "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function envList(name, fallback) {
    const raw = String(process.env[name] || "").trim();

    if (!raw) {
        return fallback;
    }

    return [
        ...new Set(
            raw
                .split(",")
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean),
        ),
    ];
}

const DRY_RUN =
    envFlag("CHAMBER_INGEST_DRY_RUN", true);

const REQUIRE_EMAIL =
    envFlag("CHAMBER_INGEST_REQUIRE_EMAIL", true);

const ENRICH_WEBSITE_EMAILS =
    envFlag("CHAMBER_INGEST_ENRICH_WEBSITE_EMAILS", true);

const SOURCES =
    envList(
        "CHAMBER_INGEST_SOURCES",
        ["allen", "mckinney", "frisco", "coppell"],
    );

const MAX_INSERTS_PER_SOURCE =
    envInt("CHAMBER_INGEST_MAX_INSERTS_PER_SOURCE", 50);

const MAX_ITEMS_PER_SOURCE =
    envInt("CHAMBER_INGEST_MAX_ITEMS_PER_SOURCE", 0);

const MAX_DIRECTORY_PAGES =
    envInt("CHAMBER_INGEST_MAX_DIRECTORY_PAGES", 100);

const REQUEST_DELAY_MS =
    envInt("CHAMBER_INGEST_REQUEST_DELAY_MS", 400);

const REQUEST_TIMEOUT_MS =
    envInt("CHAMBER_INGEST_REQUEST_TIMEOUT_MS", 20_000);

const WEBSITE_EMAIL_MAX_PAGES =
    envInt("CHAMBER_INGEST_WEBSITE_EMAIL_MAX_PAGES", 3);

const USER_AGENT =
    String(
        process.env.CHAMBER_INGEST_USER_AGENT ||
        "ClubhouseLinks-ChamberDirectoryIngest/1.0",
    ).trim();

/* --------------------------------------------------------------------------
 * Database
 * ----------------------------------------------------------------------- */

function buildPool() {
    const connectionString =
        process.env.DATABASE_URL ||
        (
            process.env.DB_USER &&
            process.env.DB_HOST &&
            process.env.DB_NAME
                ? `postgres://${encodeURIComponent(
                    process.env.DB_USER,
                )}:${encodeURIComponent(
                    process.env.DB_PASSWORD || "",
                )}@${process.env.DB_HOST}:${
                    process.env.DB_PORT || 5432
                }/${encodeURIComponent(
                    process.env.DB_NAME,
                )}`
                : null
        );

    if (!connectionString) {
        throw new Error(
            "No Postgres connection configured. Set DATABASE_URL or DB_* variables.",
        );
    }

    return new Pool({
        connectionString,
        ssl: {
            rejectUnauthorized: false,
        },
    });
}

const pool = buildPool();

/* --------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

function cleanText(value) {
    return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeEmail(value) {
    const email = cleanText(value).toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/.test(email)) {
        return null;
    }

    const [localPart, domain] = email.split("@");

    if (
        !localPart ||
        !domain ||
        /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|json|xml|woff2?|ttf)$/i.test(domain)
    ) {
        return null;
    }

    if (
        /^x+$/i.test(localPart) ||
        /^x+(?:\.x+)+$/i.test(domain) ||
        /^(?:test|example|email|name)$/i.test(localPart)
    ) {
        return null;
    }

    return email;
}

function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");

    if (digits.length < 10) {
        return null;
    }

    return digits.slice(-10);
}

function absoluteUrl(href, baseUrl) {
    try {
        return new URL(href, baseUrl).href;
    } catch {
        return null;
    }
}

function unique(values) {
    return [
        ...new Set(
            values
                .map((value) => cleanText(value))
                .filter(Boolean),
        ),
    ];
}

function parseCity(text, fallback = null) {
    const value = cleanText(text);
    const match =
        value.match(/(?:^|,|\s)([A-Za-z .'-]+?)\s*,?\s*TX\s*,?\s*\d{5}(?:-\d{4})?\b/i);

    return cleanText(match?.[1]) || fallback;
}

function looksLikeWebsite(value) {
    const text = cleanText(value);

    return (
        /^https?:\/\//i.test(text) ||
        /^www\./i.test(text) ||
        /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(text)
    );
}

function websiteUrl(value) {
    const text = cleanText(value);

    if (!looksLikeWebsite(text)) {
        return null;
    }

    return /^https?:\/\//i.test(text)
        ? text
        : `https://${text}`;
}

let lastRequestAt = 0;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
    const waitMs =
        Math.max(
            0,
            REQUEST_DELAY_MS - (Date.now() - lastRequestAt),
        );

    if (waitMs > 0) {
        await sleep(waitMs);
    }

    lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
    );

    try {
        const response = await fetch(
            url,
            {
                redirect: "follow",
                signal: controller.signal,
                headers: {
                    "User-Agent": USER_AGENT,
                    Accept:
                        "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            },
        );

        const text = await response.text();

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}: ${text.slice(0, 200)}`,
            );
        }

        return {
            text,
            finalUrl: response.url || url,
        };
    } finally {
        clearTimeout(timer);
    }
}

/* --------------------------------------------------------------------------
 * Public email discovery
 * ----------------------------------------------------------------------- */

const BLOCKED_EMAIL_DOMAINS = new Set([
    "allenchamber.com",
    "mckinneychamber.com",
    "coppellchamber.org",
    "friscochamber.com",
    "growthzone.com",
    "chamberpages.net",
    "avada-company.com",
    "example.com",
]);

function extractEmails(html) {
    const $ = cheerio.load(html);
    const candidates = [];

    $('a[href^="mailto:"]').each((_, element) => {
        const href = $(element).attr("href") || "";
        candidates.push(
            href.replace(/^mailto:/i, "").split("?")[0],
        );
    });

    const matches =
        String(html || "")
            .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}(?![A-Z])/gi) || [];

    candidates.push(...matches);

    return unique(candidates)
        .map(normalizeEmail)
        .filter(Boolean)
        .filter((email) => {
            const domain = email.split("@")[1];

            return ![...BLOCKED_EMAIL_DOMAINS]
                .some(
                    (blocked) =>
                        domain === blocked ||
                        domain.endsWith(`.${blocked}`),
                );
        });
}

function scoreEmail(email, website) {
    const [local, domain] = email.split("@");
    let score = 0;

    try {
        const websiteDomain =
            new URL(website).hostname.replace(/^www\./, "").toLowerCase();

        if (
            domain === websiteDomain ||
            domain.endsWith(`.${websiteDomain}`)
        ) {
            score += 100;
        }
    } catch {
        // No website domain score.
    }

    if (/^(info|contact|hello|office|sales|service|admin)$/i.test(local)) {
        score += 20;
    }

    if (/^(noreply|no-reply|privacy|abuse|webmaster)$/i.test(local)) {
        score -= 1000;
    }

    return score;
}

async function findWebsiteEmail(website) {
    if (!website) {
        return null;
    }

    let home;

    try {
        home = await fetchText(website);
    } catch (error) {
        console.warn(
            `[chamber-ingest] Website skipped ${website}: ${error.message}`,
        );
        return null;
    }

    const pageUrls = [home.finalUrl];
    const $ = cheerio.load(home.text);

    $('a[href]').each((_, element) => {
        const href = cleanText($(element).attr("href"));
        const label = cleanText($(element).text());

        if (!/(contact|about|team|staff)/i.test(`${href} ${label}`)) {
            return;
        }

        const url = absoluteUrl(href, home.finalUrl);

        if (!url) {
            return;
        }

        try {
            if (
                new URL(url).hostname ===
                new URL(home.finalUrl).hostname
            ) {
                pageUrls.push(url);
            }
        } catch {
            // Ignore malformed links.
        }
    });

    const emails = [
        ...extractEmails(home.text),
    ];

    for (
        const url of unique(pageUrls).slice(1, WEBSITE_EMAIL_MAX_PAGES)
    ) {
        try {
            const page = await fetchText(url);
            emails.push(...extractEmails(page.text));
        } catch {
            // A missing contact page should not fail the whole business.
        }
    }

    return unique(emails)
        .map((email) => ({
            email,
            score: scoreEmail(email, home.finalUrl),
        }))
        .filter((item) => item.score > -1000)
        .sort((a, b) => b.score - a.score)[0]?.email || null;
}

/* --------------------------------------------------------------------------
 * Existing-record detection + safe upsert
 * ----------------------------------------------------------------------- */

async function findExisting(record) {
    const email = normalizeEmail(record.email);
    const phone = normalizePhone(record.phone);

    const { rows } = await pool.query(
        `
            SELECT
                id,
                name,
                company_name,
                phone,
                email,
                industry_guess,
                city,
                industry_classified_at

            FROM chamber_of_commerce

            WHERE
                (
                    $1::text IS NOT NULL
                    AND LOWER(BTRIM(email)) = $1
                )

                OR (
                    $2::text IS NOT NULL
                    AND RIGHT(
                        regexp_replace(
                            COALESCE(phone, ''),
                            '[^0-9]',
                            '',
                            'g'
                        ),
                        10
                    ) = $2
                )

                OR (
                    LOWER(BTRIM(company_name)) =
                        LOWER(BTRIM($3))

                    AND LOWER(BTRIM(COALESCE(city, ''))) =
                        LOWER(BTRIM(COALESCE($4, '')))
                )

            ORDER BY id ASC
            LIMIT 1
        `,
        [
            email,
            phone,
            record.companyName,
            record.city || "",
        ],
    );

    return rows[0] || null;
}

async function upsertRecord(record) {
    const existing = await findExisting(record);

    /*
     * Never replace a non-empty existing email automatically.
     * This protects manual corrections such as Brandon's updated address.
     */
    const finalEmail =
        normalizeEmail(existing?.email) ||
        normalizeEmail(record.email);

    if (existing) {
        const materialCategoryChange =
            cleanText(record.category) &&
            cleanText(existing.industry_guess).toLowerCase() !==
                cleanText(record.category).toLowerCase();

        if (DRY_RUN) {
            return {
                action: "would_update",
                id: existing.id,
                email: finalEmail,
            };
        }

        await pool.query(
            `
                UPDATE chamber_of_commerce

                SET
                    name = COALESCE(
                        NULLIF(BTRIM(name), ''),
                        NULLIF(BTRIM($2), ''),
                        company_name
                    ),

                    phone = COALESCE(
                        NULLIF(BTRIM(phone), ''),
                        NULLIF(BTRIM($3), '')
                    ),

                    email = COALESCE(
                        NULLIF(BTRIM(email), ''),
                        NULLIF(BTRIM($4), '')
                    ),

                    industry_guess = COALESCE(
                        NULLIF(BTRIM($5), ''),
                        industry_guess
                    ),

                    city = COALESCE(
                        NULLIF(BTRIM(city), ''),
                        NULLIF(BTRIM($6), '')
                    ),

                    industry_classified_at =
                        CASE
                            WHEN $7::boolean
                                THEN NULL
                            ELSE industry_classified_at
                        END

                WHERE id = $1
            `,
            [
                existing.id,
                record.contactName || record.companyName,
                record.phone || null,
                finalEmail,
                record.category || null,
                record.city || null,
                materialCategoryChange,
            ],
        );

        return {
            action: "updated",
            id: existing.id,
            email: finalEmail,
        };
    }

    if (REQUIRE_EMAIL && !finalEmail) {
        return {
            action: "skipped_no_email",
            id: null,
            email: null,
        };
    }

    if (DRY_RUN) {
        return {
            action: "would_insert",
            id: null,
            email: finalEmail,
        };
    }

    const { rows } = await pool.query(
        `
            INSERT INTO chamber_of_commerce (
                name,
                company_name,
                phone,
                email,
                industry_guess,
                city
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `,
        [
            record.contactName || record.companyName,
            record.companyName,
            record.phone || null,
            finalEmail,
            record.category || null,
            record.city || null,
        ],
    );

    return {
        action: "inserted",
        id: rows[0].id,
        email: finalEmail,
    };
}

/* --------------------------------------------------------------------------
 * GrowthZone directories: McKinney + Coppell
 * ----------------------------------------------------------------------- */

const DIRECTORY_TERMS = [
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
    "#!",
];

function growthZoneMemberLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const links = [];

    $('a[href]').each((_, element) => {
        const href = $(element).attr("href") || "";

        if (!/(\/list\/Details\/|\/member-directory\/Details\/)/i.test(href)) {
            return;
        }

        const url = absoluteUrl(href, baseUrl);
        if (url) links.push(url);
    });

    return unique(links);
}

function externalWebsiteFromPage($, pageUrl) {
    const sourceHost = new URL(pageUrl).hostname;
    const candidates = [];

    $('a[href]').each((_, element) => {
        const href = cleanText($(element).attr("href"));
        const label = cleanText($(element).text());

        if (href) {
            candidates.push({ href, label });
        }
    });

    const preferred = candidates.find((item) =>
        /(visit website|website)/i.test(item.label),
    );

    for (const item of [preferred, ...candidates].filter(Boolean)) {
        try {
            const resolved =
                absoluteUrl(item.href, pageUrl);

            if (!resolved) {
                continue;
            }

            const url = new URL(resolved);

            /*
             * Only real web URLs are valid company websites.
             *
             * GrowthZone member pages also contain tel:, mailto:, and other
             * action links. URL() accepts those schemes, and because they have
             * no hostname they previously looked "external" and could be
             * returned as the website (for example tel:+19723932829).
             */
            if (
                !["http:", "https:"].includes(url.protocol)
            ) {
                continue;
            }

            if (
                url.hostname !== sourceHost &&
                !/(google\.com|facebook\.com|instagram\.com|linkedin\.com|growthzone\.com)/i
                    .test(url.hostname)
            ) {
                return url.href;
            }
        } catch {
            // Ignore malformed external URL.
        }
    }

    return null;
}

function growthZoneCompanyName($) {
    const rejected = /^(active )?member directory$|^member directory$|^directory$/i;
    const names = [];

    $("h1").each((_, element) => {
        const value = cleanText($(element).text());

        if (value && !rejected.test(value)) {
            names.push(value);
        }
    });

    return names[0] || null;
}

function growthZoneCategory($) {
    const selectorValues = [];

    [
        ".gz-details-categories a",
        ".gz-details-categories",
        ".mn-member-categories a",
        ".mn-member-categories",
        "[class*='categor'] a",
    ].forEach((selector) => {
        $(selector).each((_, element) => {
            const value = cleanText($(element).text());

            if (
                value &&
                !/^categories?$/i.test(value)
            ) {
                selectorValues.push(value);
            }
        });
    });

    if (selectorValues.length) {
        return unique(selectorValues).join(", ");
    }

    const text = $("body").text().replace(/\s+/g, " ");
    const match = text.match(
        /Categories?\s+(.+?)(?:\s+(?:About|Contacts?|Hours|Rep\/Contact Info|Driving Directions)\b|$)/i,
    );

    return cleanText(match?.[1]) || null;
}

function growthZoneContactName($, companyName) {
    const candidates = [];

    [
        ".gz-member-repname",
        ".gz-rep-name",
        ".mn-member-rep-name",
        "[class*='rep-name']",
    ].forEach((selector) => {
        $(selector).each((_, element) => {
            const value = cleanText($(element).text());

            if (
                value &&
                value.toLowerCase() !==
                    String(companyName || "").toLowerCase()
            ) {
                candidates.push(value);
            }
        });
    });

    return candidates[0] || null;
}

function phoneFromPage($) {
    const tel =
        cleanText($('a[href^="tel:"]').first().attr("href"))
            .replace(/^tel:/i, "");

    if (normalizePhone(tel)) {
        return tel;
    }

    const match =
        $("body")
            .text()
            .match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/);

    return cleanText(match?.[0]) || null;
}

async function parseGrowthZoneMember(url, source) {
    const page = await fetchText(url);
    const $ = cheerio.load(page.text);

    const companyName = growthZoneCompanyName($);

    if (!companyName) {
        throw new Error("Could not identify member company name.");
    }

    const bodyText = cleanText($("body").text());
    const website = externalWebsiteFromPage($, page.finalUrl);
    const directEmail = extractEmails(page.text)[0] || null;

    return {
        source: source.key,
        sourceUrl: page.finalUrl,
        companyName,
        contactName: growthZoneContactName($, companyName),
        phone: phoneFromPage($),
        email: directEmail,
        website,
        category: growthZoneCategory($),
        city: parseCity(bodyText, source.defaultCity),
    };
}

async function discoverGrowthZone(source) {
    const links = [];

    for (const term of DIRECTORY_TERMS) {
        const url =
            `${source.baseUrl}${source.directoryPath}` +
            encodeURIComponent(term);

        try {
            const page = await fetchText(url);
            const found = growthZoneMemberLinks(
                page.text,
                page.finalUrl,
            );

            links.push(...found);

            console.log(
                `[chamber-ingest:${source.key}] directory ${term}: ` +
                `${found.length} profile(s)`,
            );
        } catch (error) {
            console.warn(
                `[chamber-ingest:${source.key}] directory ${term} failed: ` +
                error.message,
            );
        }
    }

    return unique(links);
}

/* --------------------------------------------------------------------------
 * Frisco ChamberPages directory
 * ----------------------------------------------------------------------- */

function friscoProfileLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const links = [];

    $('a[href*="/business/"]').each((_, element) => {
        const url = absoluteUrl(
            $(element).attr("href"),
            baseUrl,
        );

        if (url) links.push(url);
    });

    return unique(links);
}

async function discoverFrisco(source) {
    const seen = new Set();
    let emptyOrRepeatedPages = 0;

    for (
        let pageNumber = 1;
        pageNumber <= MAX_DIRECTORY_PAGES;
        pageNumber += 1
    ) {
        const url =
            `${source.baseUrl}/search?page=${pageNumber}`;

        const page = await fetchText(url);
        const found = friscoProfileLinks(
            page.text,
            page.finalUrl,
        );

        let added = 0;

        for (const link of found) {
            if (!seen.has(link)) {
                seen.add(link);
                added += 1;
            }
        }

        console.log(
            `[chamber-ingest:frisco] page=${pageNumber} ` +
            `profiles=${found.length} new=${added}`,
        );

        if (!found.length || !added) {
            emptyOrRepeatedPages += 1;
        } else {
            emptyOrRepeatedPages = 0;
        }

        if (emptyOrRepeatedPages >= 2) {
            break;
        }
    }

    return [...seen];
}

async function parseFriscoMember(url, source) {
    const page = await fetchText(url);
    const $ = cheerio.load(page.text);

    const companyName =
        cleanText($("h1").first().text()) ||
        cleanText($("h2").first().text());

    if (!companyName) {
        throw new Error("Could not identify Frisco member company name.");
    }

    const bodyText = cleanText($("body").text());
    const website = externalWebsiteFromPage($, page.finalUrl);
    const directEmail = extractEmails(page.text)[0] || null;

    let category = null;
    const categoryCandidates = [];

    $('a[href*="category="]').each((_, element) => {
        const value = cleanText($(element).text());
        if (value) categoryCandidates.push(value);
    });

    if (categoryCandidates.length) {
        category = unique(categoryCandidates).join(", ");
    }

    return {
        source: source.key,
        sourceUrl: page.finalUrl,
        companyName,
        contactName: null,
        phone: phoneFromPage($),
        email: directEmail,
        website,
        category,
        city: parseCity(bodyText, source.defaultCity),
    };
}

/* --------------------------------------------------------------------------
 * Allen Chamber community guide
 * ----------------------------------------------------------------------- */

function allenGuideRecords(html, source) {
    const $ = cheerio.load(html);
    const lines = $("body")
        .text()
        .split(/\r?\n/)
        .map(cleanText)
        .filter(Boolean);

    const start = lines.findIndex((line) =>
        /^Member Directory(?:\s+-\s+Alphabetical)?$/i.test(line),
    );

    const end = lines.findIndex(
        (line, index) =>
            index > start &&
            /^(Member Search|Advertiser Index)$/i.test(line),
    );

    const directoryLines =
        lines.slice(
            start >= 0 ? start + 1 : 0,
            end > start ? end : lines.length,
        );

    const records = [];

    for (
        let index = 0;
        index < directoryLines.length;
        index += 1
    ) {
        const phone = directoryLines[index];

        if (!normalizePhone(phone)) {
            continue;
        }

        let city = source.defaultCity;

        for (
            let back = index - 1;
            back >= Math.max(0, index - 6);
            back -= 1
        ) {
            const parsed = parseCity(directoryLines[back], null);

            if (parsed) {
                city = parsed;
                break;
            }
        }

        let companyName = null;

        for (
            let back = index - 1;
            back >= Math.max(0, index - 8);
            back -= 1
        ) {
            const candidate = directoryLines[back];

            if (
                !candidate ||
                parseCity(candidate, null) ||
                /^\d/.test(candidate) ||
                /^(suite|ste\.?|building|bldg\.?|unit|#)/i.test(candidate) ||
                normalizePhone(candidate) ||
                looksLikeWebsite(candidate)
            ) {
                continue;
            }

            companyName = candidate;
            break;
        }

        if (!companyName) {
            continue;
        }

        let website = null;

        for (
            let forward = index + 1;
            forward <= Math.min(directoryLines.length - 1, index + 3);
            forward += 1
        ) {
            website = websiteUrl(directoryLines[forward]);
            if (website) break;
        }

        records.push({
            source: source.key,
            sourceUrl: source.guideUrl,
            companyName,
            contactName: null,
            phone,
            email: null,
            website,
            category: null,
            city,
        });
    }

    const byKey = new Map();

    for (const record of records) {
        const key =
            `${record.companyName.toLowerCase()}|` +
            `${record.city.toLowerCase()}|` +
            `${normalizePhone(record.phone) || ""}`;

        if (!byKey.has(key)) {
            byKey.set(key, record);
        }
    }

    return [...byKey.values()];
}

async function discoverAllen(source) {
    const page = await fetchText(source.guideUrl);
    const records = allenGuideRecords(page.text, source);

    console.log(
        `[chamber-ingest:allen] guide records=${records.length}`,
    );

    return records;
}

/* --------------------------------------------------------------------------
 * Sources
 * ----------------------------------------------------------------------- */

const SOURCE_CONFIG = {
    allen: {
        key: "allen",
        type: "allen_guide",
        name: "Allen Chamber of Commerce",
        defaultCity: "Allen",
        guideUrl: "https://chambervu.com/allen27/",
    },

    mckinney: {
        key: "mckinney",
        type: "growthzone",
        name: "McKinney Chamber of Commerce",
        defaultCity: "McKinney",
        baseUrl: "https://business.mckinneychamber.com",
        directoryPath: "/list/FindStartsWith?term=",
    },

    coppell: {
        key: "coppell",
        type: "growthzone",
        name: "Coppell Chamber of Commerce",
        defaultCity: "Coppell",
        baseUrl: "https://business.coppellchamber.org",
        directoryPath: "/member-directory/FindStartsWith?term=",
    },

    frisco: {
        key: "frisco",
        type: "frisco",
        name: "Frisco Chamber of Commerce",
        defaultCity: "Frisco",
        baseUrl: "https://app.friscochamber.com",
    },
};

async function discoverSource(source) {
    if (source.type === "growthzone") {
        return discoverGrowthZone(source);
    }

    if (source.type === "frisco") {
        return discoverFrisco(source);
    }

    if (source.type === "allen_guide") {
        return discoverAllen(source);
    }

    throw new Error(`Unsupported source type: ${source.type}`);
}

async function parseSourceItem(source, item) {
    if (source.type === "growthzone") {
        return parseGrowthZoneMember(item, source);
    }

    if (source.type === "frisco") {
        return parseFriscoMember(item, source);
    }

    if (source.type === "allen_guide") {
        return item;
    }

    throw new Error(`Unsupported source type: ${source.type}`);
}

/* --------------------------------------------------------------------------
 * Run one source
 * ----------------------------------------------------------------------- */

async function prepareRecord(record) {
    const existing = await findExisting(record);

    if (
        normalizeEmail(record.email) ||
        normalizeEmail(existing?.email) ||
        !ENRICH_WEBSITE_EMAILS ||
        !record.website
    ) {
        return record;
    }

    const discoveredEmail =
        await findWebsiteEmail(record.website);

    if (!discoveredEmail) {
        return record;
    }

    console.log(
        `[chamber-ingest:${record.source}] email ${record.companyName} -> ` +
        discoveredEmail,
    );

    return {
        ...record,
        email: discoveredEmail,
    };
}

async function runSource(source) {
    console.log("");
    console.log("============================================================");
    console.log(`[chamber-ingest] ${source.name}`);
    console.log("============================================================");

    const items = await discoverSource(source);

    const stats = {
        discovered: items.length,
        inserted: 0,
        updated: 0,
        would_insert: 0,
        would_update: 0,
        skipped_no_email: 0,
        errors: 0,
    };

    let newCount = 0;

    for (
        let index = 0;
        index < items.length;
        index += 1
    ) {
        if (
            MAX_ITEMS_PER_SOURCE > 0 &&
            index >= MAX_ITEMS_PER_SOURCE
        ) {
            console.log(
                `[chamber-ingest:${source.key}] ` +
                `Reached CHAMBER_INGEST_MAX_ITEMS_PER_SOURCE=` +
                `${MAX_ITEMS_PER_SOURCE}`,
            );
            break;
        }

        if (
            MAX_INSERTS_PER_SOURCE > 0 &&
            newCount >= MAX_INSERTS_PER_SOURCE
        ) {
            console.log(
                `[chamber-ingest:${source.key}] ` +
                `Reached CHAMBER_INGEST_MAX_INSERTS_PER_SOURCE=` +
                `${MAX_INSERTS_PER_SOURCE}`,
            );
            break;
        }

        try {
            let record =
                await parseSourceItem(source, items[index]);

            record = await prepareRecord(record);

            const result = await upsertRecord(record);

            if (Object.prototype.hasOwnProperty.call(stats, result.action)) {
                stats[result.action] += 1;
            }

            if (
                result.action === "inserted" ||
                result.action === "would_insert"
            ) {
                newCount += 1;
            }

            console.log(
                `[chamber-ingest:${source.key}] ` +
                `${index + 1}/${items.length} ` +
                `${result.action.toUpperCase()} ` +
                `${record.companyName}` +
                (result.id ? ` (id=${result.id})` : "") +
                (result.email ? ` <${result.email}>` : " <no-email>"),
            );
        } catch (error) {
            stats.errors += 1;

            console.error(
                `[chamber-ingest:${source.key}] item ${index + 1} failed: ` +
                error.message,
            );
        }
    }

    console.log(
        `[chamber-ingest:${source.key}] COMPLETE ` +
        Object.entries(stats)
            .map(([key, value]) => `${key}=${value}`)
            .join(" "),
    );

    return stats;
}

/* --------------------------------------------------------------------------
 * Main
 * ----------------------------------------------------------------------- */

async function main() {
    console.log(
        `[chamber-ingest] Starting ${new Date().toISOString()}`,
    );

    console.log(
        `[chamber-ingest] sources=${SOURCES.join(",")}`,
    );

    console.log(
        `[chamber-ingest] dry_run=${DRY_RUN} ` +
        `require_email=${REQUIRE_EMAIL} ` +
        `website_email_enrichment=${ENRICH_WEBSITE_EMAILS}`,
    );

    const totals = {
        discovered: 0,
        inserted: 0,
        updated: 0,
        would_insert: 0,
        would_update: 0,
        skipped_no_email: 0,
        errors: 0,
    };

    for (const sourceKey of SOURCES) {
        const source = SOURCE_CONFIG[sourceKey];

        if (!source) {
            totals.errors += 1;
            console.error(
                `[chamber-ingest] Unknown source "${sourceKey}".`,
            );
            continue;
        }

        try {
            const stats = await runSource(source);

            for (const [key, value] of Object.entries(stats)) {
                totals[key] =
                    (totals[key] || 0) + Number(value || 0);
            }
        } catch (error) {
            totals.errors += 1;
            console.error(
                `[chamber-ingest:${sourceKey}] Fatal source error:`,
                error,
            );
        }
    }

    console.log("");
    console.log(
        `[chamber-ingest] COMPLETE ` +
        Object.entries(totals)
            .map(([key, value]) => `${key}=${value}`)
            .join(" "),
    );

    if (totals.errors > 0) {
        process.exitCode = 1;
    }
}

main()
    .catch((error) => {
        console.error(
            "[chamber-ingest] Fatal:",
            error,
        );

        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
