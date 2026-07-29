import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { buildMemoroomContactName, chooseReservationForContact } from "@/lib/google-people-contact-name";
import { formatKoreanPhone, isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { prisma } from "@/lib/prisma";

const PEOPLE_API_BASE = "https://people.googleapis.com/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SYNC_STATUS_KEY = "googlePeople.syncStatus";
const CONTACT_SETTING_PREFIX = "googlePeople.contact.";
const SYNC_ALERT_KEY = "google-people-sync";
const CONTACT_MARKER_KEY = "머무룸 관리";
const CONTACT_MARKER_VALUE = "자동 동기화";
const DEFAULT_CREDENTIALS_PATH = "/srv/memoroom/shared/google-people-credentials.json";
const DEFAULT_TOKEN_PATH = "/srv/memoroom/shared/google-people-token.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTACT_LOOKAHEAD_DAYS = 7;
const CONTACT_RETENTION_HOURS = 48;

type GoogleOAuthCredentials = {
  client_id: string;
  client_secret: string;
};

type GoogleOAuthToken = {
  access_token?: string;
  refresh_token: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  email?: string;
  connected_at?: string;
};

type GooglePerson = {
  resourceName?: string;
  etag?: string;
  metadata?: {
    sources?: Array<Record<string, unknown>>;
  };
  names?: Array<Record<string, unknown> & {
    displayName?: string;
    givenName?: string;
  }>;
  phoneNumbers?: Array<Record<string, unknown> & {
    value?: string;
    canonicalForm?: string;
    type?: string;
  }>;
  userDefined?: Array<Record<string, unknown> & {
    key?: string;
    value?: string;
  }>;
};

type ContactMapping = {
  resourceName: string;
  ownership: "CREATED" | "ADOPTED";
  original?: {
    names: Array<Record<string, string>>;
    phoneNumbers: Array<{ value: string; type?: string }>;
    userDefined: Array<{ key: string; value: string }>;
  };
};

type StoredSyncStatus = {
  lastSyncAt?: string;
  lastSuccessAt?: string;
  lastError?: string | null;
  checkedCount?: number;
  createdCount?: number;
  updatedCount?: number;
  unchangedCount?: number;
  deletedCount?: number;
  restoredCount?: number;
};

export type GooglePeopleStatus = {
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  checkedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  deletedCount: number;
  restoredCount: number;
};

export type GooglePeopleSyncResult = {
  skipped: boolean;
  reason?: string;
  checkedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  deletedCount: number;
  restoredCount: number;
};

export type GooglePeopleImmediateSyncResult = {
  success: boolean;
  skipped: boolean;
  timedOut: boolean;
  reason?: string;
  syncResult?: GooglePeopleSyncResult;
};

class PeopleApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PeopleApiError";
  }
}

function credentialsPath() {
  return process.env.GOOGLE_PEOPLE_CREDENTIALS_PATH?.trim() || DEFAULT_CREDENTIALS_PATH;
}

function tokenPath() {
  return process.env.GOOGLE_PEOPLE_TOKEN_PATH?.trim() || DEFAULT_TOKEN_PATH;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivateJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function loadCredentials() {
  const credentials = await readJsonFile<GoogleOAuthCredentials>(credentialsPath());
  if (!credentials?.client_id || !credentials.client_secret) return null;
  return credentials;
}

async function loadToken() {
  const token = await readJsonFile<GoogleOAuthToken>(tokenPath());
  if (!token?.refresh_token) return null;
  return token;
}

async function getAccessToken() {
  const [credentials, token] = await Promise.all([loadCredentials(), loadToken()]);
  if (!credentials) throw new Error("Google People OAuth 클라이언트가 설정되지 않았습니다.");
  if (!token) throw new Error("와이프 Google 계정 연결이 필요합니다.");

  if (token.access_token && (token.expires_at || 0) > Date.now() + 60_000) {
    return token.access_token;
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  const payload = await response.json() as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Google 토큰 갱신 실패 (${response.status})`);
  }

  const refreshedToken: GoogleOAuthToken = {
    ...token,
    access_token: payload.access_token,
    expires_at: Date.now() + Math.max(60, payload.expires_in || 3600) * 1000,
    token_type: payload.token_type || token.token_type,
    scope: payload.scope || token.scope,
  };
  await writePrivateJson(tokenPath(), refreshedToken);
  return payload.access_token;
}

async function peopleRequest<T>(pathname: string, init: RequestInit = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${PEOPLE_API_BASE}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as T & {
    error?: { message?: string; status?: string };
  };
  if (!response.ok) {
    throw new PeopleApiError(payload.error?.message || `Google People API 오류 (${response.status})`, response.status);
  }
  return payload as T;
}

function contactSettingKey(phone: string) {
  return `${CONTACT_SETTING_PREFIX}${createHash("sha256").update(phone).digest("hex")}`;
}

function parseContactMapping(value: string): ContactMapping | null {
  try {
    const parsed = JSON.parse(value) as ContactMapping;
    if (parsed.resourceName && ["CREATED", "ADOPTED"].includes(parsed.ownership)) return parsed;
  } catch {
    if (value.startsWith("people/")) {
      return { resourceName: value, ownership: "CREATED" };
    }
  }
  return null;
}

function snapshotOriginalPerson(person: GooglePerson): ContactMapping["original"] {
  const writableNameKeys = [
    "givenName",
    "familyName",
    "middleName",
    "honorificPrefix",
    "honorificSuffix",
    "phoneticGivenName",
    "phoneticFamilyName",
    "phoneticMiddleName",
    "phoneticHonorificPrefix",
    "phoneticHonorificSuffix",
    "unstructuredName",
  ];
  return {
    names: (person.names || []).map((name) => Object.fromEntries(
      writableNameKeys
        .filter((key) => typeof name[key] === "string" && name[key])
        .map((key) => [key, String(name[key])]),
    )).filter((name) => Object.keys(name).length > 0),
    phoneNumbers: (person.phoneNumbers || [])
      .filter((phone) => typeof phone.value === "string" && phone.value)
      .map((phone) => ({ value: String(phone.value), ...(phone.type ? { type: phone.type } : {}) })),
    userDefined: (person.userDefined || [])
      .filter((field) => typeof field.key === "string" && typeof field.value === "string")
      .map((field) => ({ key: String(field.key), value: String(field.value) })),
  };
}

function personPhone(person: GooglePerson) {
  for (const phoneNumber of person.phoneNumbers || []) {
    const normalized = normalizeKoreanPhone(phoneNumber.canonicalForm || phoneNumber.value);
    if (isValidKoreanMobilePhone(normalized)) return normalized;
  }
  return "";
}

function personDisplayName(person: GooglePerson) {
  return person.names?.[0]?.displayName || person.names?.[0]?.givenName || "";
}

function personBody(person: GooglePerson | null, displayName: string, phone: string) {
  const userDefined = (person?.userDefined || [])
    .filter((field) => field.key !== CONTACT_MARKER_KEY && field.key && field.value)
    .map((field) => ({ key: String(field.key), value: String(field.value) }));
  userDefined.push({ key: CONTACT_MARKER_KEY, value: CONTACT_MARKER_VALUE });
  return {
    ...(person?.resourceName ? { resourceName: person.resourceName } : {}),
    ...(person?.etag ? { etag: person.etag } : {}),
    ...(person?.metadata ? { metadata: person.metadata } : {}),
    names: [{ givenName: displayName }],
    phoneNumbers: [{ value: formatKoreanPhone(phone), type: "mobile" }],
    userDefined,
  };
}

async function listConnections() {
  const people: GooglePerson[] = [];
  let pageToken = "";
  do {
    const search = new URLSearchParams({
      personFields: "names,phoneNumbers,userDefined,metadata",
      pageSize: "1000",
    });
    if (pageToken) search.set("pageToken", pageToken);
    const payload = await peopleRequest<{
      connections?: GooglePerson[];
      nextPageToken?: string;
    }>(`/people/me/connections?${search.toString()}`);
    people.push(...(payload.connections || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return people;
}

async function getPerson(resourceName: string) {
  const search = new URLSearchParams({ personFields: "names,phoneNumbers,userDefined,metadata" });
  try {
    return await peopleRequest<GooglePerson>(`/${resourceName}?${search.toString()}`);
  } catch (error) {
    if (error instanceof PeopleApiError && error.status === 404) return null;
    throw error;
  }
}

async function createPerson(displayName: string, phone: string) {
  return peopleRequest<GooglePerson>("/people:createContact", {
    method: "POST",
    body: JSON.stringify(personBody(null, displayName, phone)),
  });
}

async function updatePerson(person: GooglePerson, displayName: string, phone: string) {
  if (!person.resourceName) throw new Error("Google 연락처 resourceName이 없습니다.");
  const search = new URLSearchParams({ updatePersonFields: "names,phoneNumbers,userDefined" });
  return peopleRequest<GooglePerson>(`/${person.resourceName}:updateContact?${search.toString()}`, {
    method: "PATCH",
    body: JSON.stringify(personBody(person, displayName, phone)),
  });
}

async function restorePerson(person: GooglePerson, mapping: ContactMapping) {
  if (!person.resourceName || !mapping.original) return;
  const search = new URLSearchParams({ updatePersonFields: "names,phoneNumbers,userDefined" });
  await peopleRequest<GooglePerson>(`/${person.resourceName}:updateContact?${search.toString()}`, {
    method: "PATCH",
    body: JSON.stringify({
      resourceName: person.resourceName,
      ...(person.etag ? { etag: person.etag } : {}),
      ...(person.metadata ? { metadata: person.metadata } : {}),
      names: mapping.original.names || [],
      phoneNumbers: mapping.original.phoneNumbers || [],
      userDefined: mapping.original.userDefined || [],
    }),
  });
}

async function deletePerson(resourceName: string) {
  try {
    await peopleRequest<Record<string, never>>(`/${resourceName}:deleteContact`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof PeopleApiError && error.status === 404) return;
    throw error;
  }
}

async function saveContactMapping(phone: string, mapping: ContactMapping) {
  await prisma.appSetting.upsert({
    where: { key: contactSettingKey(phone) },
    create: { key: contactSettingKey(phone), value: JSON.stringify(mapping) },
    update: { value: JSON.stringify(mapping) },
  });
}

async function readSyncStatus() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: SYNC_STATUS_KEY },
    select: { value: true },
  });
  if (!setting?.value) return {} as StoredSyncStatus;
  try {
    return JSON.parse(setting.value) as StoredSyncStatus;
  } catch {
    return {} as StoredSyncStatus;
  }
}

async function saveSyncStatus(status: StoredSyncStatus) {
  await prisma.appSetting.upsert({
    where: { key: SYNC_STATUS_KEY },
    create: { key: SYNC_STATUS_KEY, value: JSON.stringify(status) },
    update: { value: JSON.stringify(status) },
  });
}

export async function getGooglePeopleStatus(): Promise<GooglePeopleStatus> {
  const [credentials, token, syncStatus] = await Promise.all([
    loadCredentials(),
    loadToken(),
    readSyncStatus(),
  ]);
  return {
    configured: Boolean(credentials),
    connected: Boolean(credentials && token?.refresh_token),
    accountEmail: token?.email || null,
    lastSyncAt: syncStatus.lastSyncAt || null,
    lastSuccessAt: syncStatus.lastSuccessAt || null,
    lastError: syncStatus.lastError || null,
    checkedCount: syncStatus.checkedCount || 0,
    createdCount: syncStatus.createdCount || 0,
    updatedCount: syncStatus.updatedCount || 0,
    unchangedCount: syncStatus.unchangedCount || 0,
    deletedCount: syncStatus.deletedCount || 0,
    restoredCount: syncStatus.restoredCount || 0,
  };
}

let syncQueue: Promise<GooglePeopleSyncResult> | null = null;
let syncQueueStartedAt = 0;
let syncQueueReservationId: string | null = null;

type GooglePeopleSyncOptions = {
  freshAfter?: Date;
  reservationId?: string;
};

export function syncUpcomingReservationContacts(
  now = new Date(),
  options: GooglePeopleSyncOptions = {},
): Promise<GooglePeopleSyncResult> {
  if (syncQueue) {
    const runningSyncCoversRequest = syncQueueReservationId === null
      || syncQueueReservationId === (options.reservationId || null);
    if (runningSyncCoversRequest && (!options.freshAfter || syncQueueStartedAt >= options.freshAfter.getTime())) {
      return syncQueue;
    }
    return syncQueue.then(() => syncUpcomingReservationContacts(now, options));
  }
  syncQueueStartedAt = Date.now();
  syncQueueReservationId = options.reservationId || null;
  syncQueue = runSyncUpcomingReservationContacts(now, options.reservationId).finally(() => {
    syncQueue = null;
    syncQueueReservationId = null;
  });
  return syncQueue;
}

export async function syncReservationContactImmediately(
  reservationId: string,
  now = new Date(),
  timeoutMs = 8_000,
): Promise<GooglePeopleImmediateSyncResult> {
  const requiredAfter = new Date();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutToken = Symbol("google-people-timeout");

  try {
    const result = await Promise.race([
      syncUpcomingReservationContacts(now, {
        freshAfter: requiredAfter,
        reservationId,
      }),
      new Promise<typeof timeoutToken>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutToken), Math.max(1_000, timeoutMs));
      }),
    ]);

    if (result === timeoutToken) {
      return {
        success: false,
        skipped: false,
        timedOut: true,
        reason: `Google 연락처 저장이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 문자를 먼저 발송합니다.`,
      };
    }
    if (result.skipped) {
      return {
        success: false,
        skipped: true,
        timedOut: false,
        reason: result.reason || "Google 연락처 계정이 연결되지 않았습니다.",
        syncResult: result,
      };
    }
    return {
      success: true,
      skipped: false,
      timedOut: false,
      syncResult: result,
    };
  } catch (error) {
    return {
      success: false,
      skipped: false,
      timedOut: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runSyncUpcomingReservationContacts(
  now: Date,
  reservationId?: string,
): Promise<GooglePeopleSyncResult> {
  const status = await getGooglePeopleStatus();
  if (!status.configured || !status.connected) {
    return {
      skipped: true,
      reason: !status.configured ? "Google People OAuth client is not configured." : "Google account is not connected.",
      checkedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      deletedCount: 0,
      restoredCount: 0,
    };
  }

  const syncStartedAt = new Date();
  try {
    const reservations = await prisma.reservation.findMany({
      where: reservationId
        ? {
            id: reservationId,
            status: "CONFIRMED",
            isNoShow: false,
          }
        : {
            status: "CONFIRMED",
            isNoShow: false,
            endTime: { gte: new Date(now.getTime() - CONTACT_RETENTION_HOURS * 60 * 60 * 1000) },
            startTime: { lte: new Date(now.getTime() + CONTACT_LOOKAHEAD_DAYS * DAY_MS) },
          },
      select: {
        id: true,
        roomName: true,
        customerName: true,
        phone: true,
        startTime: true,
        endTime: true,
      },
      orderBy: { startTime: "asc" },
    });

    const reservationsByPhone = new Map<string, Array<(typeof reservations)[number]>>();
    for (const reservation of reservations) {
      const phone = normalizeKoreanPhone(reservation.phone);
      if (!isValidKoreanMobilePhone(phone)) continue;
      const existing = reservationsByPhone.get(phone) || [];
      existing.push(reservation);
      reservationsByPhone.set(phone, existing);
    }

    const targets = new Map<string, (typeof reservations)[number]>();
    for (const [phone, phoneReservations] of reservationsByPhone) {
      const selected = chooseReservationForContact(phoneReservations, now);
      if (selected) targets.set(phone, selected);
    }

    const mappings = await prisma.appSetting.findMany({
      where: { key: { startsWith: CONTACT_SETTING_PREFIX } },
      select: { key: true, value: true },
    });
    const contactMappings = new Map(
      mappings.map((mapping) => [mapping.key, parseContactMapping(mapping.value)] as const),
    );
    const connections = await listConnections();
    const personByPhone = new Map<string, GooglePerson>();
    for (const person of connections) {
      const phone = personPhone(person);
      if (phone && !personByPhone.has(phone)) personByPhone.set(phone, person);
    }

    let createdCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    let deletedCount = 0;
    let restoredCount = 0;
    for (const [phone, reservation] of targets) {
      const desiredName = buildMemoroomContactName(reservation);
      const mappingKey = contactSettingKey(phone);
      let mapping = contactMappings.get(mappingKey) || null;
      let person = mapping ? await getPerson(mapping.resourceName) : null;
      if (mapping && !person) {
        await prisma.appSetting.delete({ where: { key: mappingKey } });
        mapping = null;
      }
      if (!person) person = personByPhone.get(phone) || null;

      if (!person) {
        const created = await createPerson(desiredName, phone);
        if (created.resourceName) {
          mapping = { resourceName: created.resourceName, ownership: "CREATED" };
          await saveContactMapping(phone, mapping);
        }
        createdCount += 1;
        continue;
      }

      if (!mapping && person.resourceName) {
        mapping = {
          resourceName: person.resourceName,
          ownership: "ADOPTED",
          original: snapshotOriginalPerson(person),
        };
        await saveContactMapping(phone, mapping);
      } else if (mapping) {
        await saveContactMapping(phone, mapping);
      }
      if (personDisplayName(person) === desiredName && personPhone(person) === phone) {
        unchangedCount += 1;
        continue;
      }
      await updatePerson(person, desiredName, phone);
      updatedCount += 1;
    }

    if (!reservationId) {
      const activeMappingKeys = new Set([...targets.keys()].map(contactSettingKey));
      for (const mappingRecord of mappings) {
        if (activeMappingKeys.has(mappingRecord.key)) continue;
        const mapping = contactMappings.get(mappingRecord.key);
        if (!mapping) {
          await prisma.appSetting.delete({ where: { key: mappingRecord.key } });
          continue;
        }

        if (mapping.ownership === "CREATED") {
          await deletePerson(mapping.resourceName);
          deletedCount += 1;
        } else {
          const person = await getPerson(mapping.resourceName);
          if (person) await restorePerson(person, mapping);
          restoredCount += 1;
        }
        await prisma.appSetting.delete({ where: { key: mappingRecord.key } });
      }
    }

    const result = {
      skipped: false,
      checkedCount: targets.size,
      createdCount,
      updatedCount,
      unchangedCount,
      deletedCount,
      restoredCount,
    } satisfies GooglePeopleSyncResult;
    await saveSyncStatus({
      lastSyncAt: syncStartedAt.toISOString(),
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      checkedCount: result.checkedCount,
      createdCount,
      updatedCount,
      unchangedCount,
      deletedCount,
      restoredCount,
    });
    await resolveAdminAlertByDedupeKey(SYNC_ALERT_KEY);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google 연락처 동기화에 실패했습니다.";
    const previous = await readSyncStatus();
    await saveSyncStatus({ ...previous, lastSyncAt: syncStartedAt.toISOString(), lastError: message });
    await createAdminAlert({
      type: "GOOGLE_PEOPLE_SYNC_FAILED",
      severity: "WARNING",
      title: "Google 연락처 동기화 실패",
      message,
      dedupeKey: SYNC_ALERT_KEY,
    });
    throw error;
  }
}
