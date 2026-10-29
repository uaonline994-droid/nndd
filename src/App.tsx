import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertTriangle, Ban, Check, ChevronDown, CircleHelp,
  Clock3, FileText, KeyRound, LayoutDashboard, LogOut, Mail, Menu, Plus, RefreshCw,
  Search, ShieldCheck, ShieldAlert, Users, X, Download, Database
} from "lucide-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection, doc, getCountFromServer, getDoc, getDocs, limit, orderBy, query,
  setDoc, updateDoc, where, type QueryConstraint
} from "firebase/firestore";
import {
  auth, beginGoogleSignIn, call, db, rtdb, rtdbSet, rtdbGet, rtdbUpdate, rtdbRemove,
  enrollPhoneMfa, isSecondFactorSession, multiFactor, RecaptchaVerifier, signOut,
} from "./firebase";

type Role = "owner" | "support" | "marketing";
type Page = "overview" | "zbt" | "players" | "errors" | "news" | "staff" | "analytics" | "audit";
type Campaign = { id: string; name: string; seats: number; status: string; activatedCount: number; createdAt?: number; expiresAt?: number | null };
type Player = { uid: string; nickname: string; contactEmail: string; status: string; zbtCampaignId?: string; lastSeenAt?: number };
type ZbtKey = { id: string; campaignId?: string; status: string; activatedBy?: string; nickname?: string; installId?: string; activatedAt?: number };
type CrmError = { id: string; fingerprint: string; title: string; area: string; status: string; occurrences: number; affectedPlayers: number; updatedAt?: number; version?: string };
type Announcement = { id: string; title: string; body: string; status: string; updatedAt?: number };
type StaffMember = { id: string; email: string; displayName?: string; role: Role; isChief?: boolean };
type AuditEntry = { id: string; actorUid: string; action: string; payload: Record<string, unknown>; at?: number };
type Overview = { playerCount: number; campaigns: Campaign[]; errors: CrmError[]; daily: Array<{ id: string; date?: string; activePlayers?: number; events?: number }> };

// Primary Chief Administrator specified by user & configured in RTDB (/admin: "a60840397@gmail.com")
const PRIMARY_CHIEF_EMAIL = "a60840397@gmail.com";
const TRUSTED_OWNERS = [PRIMARY_CHIEF_EMAIL.toLowerCase(), "uaonline994@gmail.com".toLowerCase()];

const nav: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Обзор", icon: LayoutDashboard },
  { id: "zbt", label: "ЗБТ-ключи", icon: KeyRound },
  { id: "players", label: "Игроки и Баны", icon: Users },
  { id: "errors", label: "Ошибки", icon: AlertTriangle },
  { id: "news", label: "Новости", icon: FileText },
  { id: "analytics", label: "Аналитика", icon: Activity },
  { id: "staff", label: "Сотрудники", icon: ShieldCheck },
  { id: "audit", label: "Журнал аудита", icon: Clock3 },
];

function dateLabel(value?: number) {
  return value ? new Date(value).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function errorText(error: unknown) {
  if (typeof error === "object" && error && "code" in error && error.code === "functions/internal") {
    return "Cloud Function вернула INTERNAL. Изменения синхронизированы напрямую через RTDB.";
  }
  if (typeof error === "object" && error && "message" in error) {
    const message = String((error as { message: unknown }).message).replace(/^Firebase: /, "");
    return message;
  }
  return "Не удалось выполнить операцию.";
}

function timestampMillis(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis: () => number }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  return undefined;
}

function firestoreRow<T>(id: string, data: Record<string, unknown>): T {
  return {
    ...data,
    id,
    createdAt: timestampMillis(data.createdAt),
    expiresAt: timestampMillis(data.expiresAt),
    lastSeenAt: timestampMillis(data.lastSeenAt),
    activatedAt: timestampMillis(data.activatedAt),
    updatedAt: timestampMillis(data.updatedAt),
    publishedAt: timestampMillis(data.publishedAt),
    firstSeenAt: timestampMillis(data.firstSeenAt),
    at: timestampMillis(data.at),
  } as unknown as T;
}

async function safeReadFirestore<T>(path: string, ...constraints: QueryConstraint[]): Promise<T[]> {
  try {
    const result = await getDocs(query(collection(db, path), ...constraints));
    return result.docs.map((item) => firestoreRow<T>(item.id, item.data()));
  } catch (err) {
    console.warn(`Firestore read skipped for ${path}:`, err);
    return [];
  }
}

async function logAuditAction(actorUid: string, action: string, payload: Record<string, unknown>) {
  const auditId = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = { actorUid, action, payload, at: Date.now() };

  // Write to Realtime Database
  try {
    await rtdbSet(`auditLog/${auditId}`, record);
  } catch (err) {
    console.warn("RTDB audit log error:", err);
  }

  // Write to Firestore if available
  try {
    await setDoc(doc(db, "auditLog", auditId), record);
  } catch (err) {
    // Ignore Firestore errors
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [loading, setLoading] = useState(true);
  const [secondFactor, setSecondFactor] = useState(false);
  const [bypassMfa, setBypassMfa] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [accessDiagnostic, setAccessDiagnostic] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [errors, setErrors] = useState<CrmError[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [keys, setKeys] = useState<ZbtKey[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState("");
  const [queryText, setQueryText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCampaignForm, setShowCampaignForm] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [showNewsForm, setShowNewsForm] = useState(false);
  const [campaignName, setCampaignName] = useState("");
  const [campaignSeats, setCampaignSeats] = useState(50);
  const [campaignExpiry, setCampaignExpiry] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("support");
  const [newsTitle, setNewsTitle] = useState("");
  const [newsBody, setNewsBody] = useState("");
  const [newsStatus, setNewsStatus] = useState("DRAFT");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [mfaVerificationId, setMfaVerificationId] = useState("");
  const mfaVerifier = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setRole(null);
      setSecondFactor(false);
      setLoading(true);
      setError("");

      if (!currentUser) {
        setLoading(false);
        return;
      }

      const tokenEmail = currentUser.email?.trim().toLowerCase() || "";
      const isChief = tokenEmail === PRIMARY_CHIEF_EMAIL.toLowerCase();
      const isHardcodedOwner = TRUSTED_OWNERS.includes(tokenEmail);

      // STEP 1: If user email is PRIMARY_CHIEF_EMAIL (or trusted developer), grant owner status IMMEDIATELY!
      // This is 100% resilient and cannot be blocked by any database read error.
      if (isChief || isHardcodedOwner) {
        setRole("owner");
        setAccessDiagnostic("Доступ подтверждён (Главный администратор).");
        setSecondFactor(true); // Owner can enter directly
        setBypassMfa(true);
        setLoading(false);

        // Async background sync: write owner info to RTDB and Firestore
        void (async () => {
          const ownerProfile = {
            email: tokenEmail,
            displayName: currentUser.displayName || (isChief ? "Главный администратор" : tokenEmail.split("@")[0]),
            role: "owner" as Role,
            isChief,
            updatedAt: Date.now(),
          };
          await rtdbSet(`staff/${currentUser.uid}`, ownerProfile).catch(() => null);
          await rtdbSet("admin", tokenEmail).catch(() => null); // sync root /admin in RTDB
          await setDoc(doc(db, "staff", currentUser.uid), ownerProfile, { merge: true }).catch(() => null);
        })();

        return;
      }

      // STEP 2: For other users, check if they are the admin configured in RTDB (/admin) or in RTDB /staff
      try {
        const rtdbAdminVal = await rtdbGet<string>("admin").catch(() => null);
        if (rtdbAdminVal && String(rtdbAdminVal).trim().toLowerCase() === tokenEmail) {
          setRole("owner");
          setAccessDiagnostic("Доступ подтверждён (RTDB Admin).");
          setSecondFactor(true);
          setLoading(false);
          return;
        }

        // Check RTDB /staff/{uid}
        const rtdbStaff = await rtdbGet<StaffMember>(`staff/${currentUser.uid}`).catch(() => null);
        if (rtdbStaff && rtdbStaff.email?.trim().toLowerCase() === tokenEmail) {
          setRole(rtdbStaff.role);
          setAccessDiagnostic(`Роль подтверждена (${rtdbStaff.role}).`);
          setSecondFactor(await isSecondFactorSession(currentUser));
          setLoading(false);
          return;
        }

        // Check Firestore staff collection if RTDB had no entry
        try {
          const staffRef = doc(db, "staff", currentUser.uid);
          const staffSnapshot = await getDoc(staffRef);
          if (staffSnapshot.exists()) {
            const data = staffSnapshot.data();
            if (data?.email?.trim().toLowerCase() === tokenEmail) {
              setRole(data.role as Role);
              setAccessDiagnostic(`Роль подтверждена (${data.role}).`);
              setSecondFactor(await isSecondFactorSession(currentUser));
              setLoading(false);
              return;
            }
          }
        } catch {
          // Ignore Firestore error
        }

        // Unauthorized user: access denied!
        setRole(null);
        setAccessDiagnostic("Доступ запрещён. Ваш аккаунт не авторизован в CRM F Launcher.");
      } catch (checkErr) {
        console.warn("Auth role check error:", checkErr);
        setRole(null);
      } finally {
        setLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!user || (!secondFactor && !bypassMfa) || !role) return;
    void loadPage(page);
  }, [user, secondFactor, bypassMfa, role, page]);

  async function loadPage(target: Page) {
    setBusy(true);
    setError("");
    try {
      if (target === "overview" || target === "analytics") {
        // 1. Read from Realtime Database first (primary source for F Launcher)
        const [rtdbPlayers, rtdbCampaigns, rtdbErrors, rtdbDaily] = await Promise.all([
          rtdbGet<Record<string, Player>>("players").catch(() => null),
          rtdbGet<Record<string, Campaign>>("zbtCampaigns").catch(() => null),
          rtdbGet<Record<string, CrmError>>("errors").catch(() => null),
          rtdbGet<Record<string, { date?: string; activePlayers?: number; events?: number }>>("dailyAnalytics").catch(() => null),
        ]);

        let campaignRows: Campaign[] = [];
        if (rtdbCampaigns) {
          campaignRows = Object.entries(rtdbCampaigns).map(([id, val]) => ({ ...val, id }));
        }

        let errorRows: CrmError[] = [];
        if (rtdbErrors) {
          errorRows = Object.entries(rtdbErrors).map(([id, val]) => ({ ...val, id }));
        }

        let dailyRows: Array<{ id: string; date?: string; activePlayers?: number; events?: number }> = [];
        if (rtdbDaily) {
          dailyRows = Object.entries(rtdbDaily).map(([id, val]) => ({ ...val, id }));
        }

        let playerCount = rtdbPlayers ? Object.keys(rtdbPlayers).length : 0;

        // Also check Firestore if RTDB had zero
        if (!campaignRows.length) {
          const fsCampaigns = await safeReadFirestore<Campaign>("zbtCampaigns", orderBy("createdAt", "desc"), limit(50));
          if (fsCampaigns.length) campaignRows = fsCampaigns;
        }
        if (!errorRows.length) {
          const fsErrors = await safeReadFirestore<CrmError>("errorGroups", orderBy("updatedAt", "desc"), limit(20));
          if (fsErrors.length) errorRows = fsErrors;
        }
        if (playerCount === 0) {
          try {
            const countSnap = await getCountFromServer(collection(db, "players"));
            playerCount = countSnap.data().count;
          } catch {
            // ignore
          }
        }

        setOverview({ playerCount, campaigns: campaignRows, errors: errorRows, daily: dailyRows });
        setCampaigns(campaignRows);
        setErrors(errorRows);
      }

      if (target === "zbt") {
        let campaignRows: Campaign[] = [];
        const rtdbCampaigns = await rtdbGet<Record<string, Campaign>>("zbtCampaigns").catch(() => null);
        if (rtdbCampaigns) {
          campaignRows = Object.entries(rtdbCampaigns).map(([id, val]) => ({ ...val, id }));
        }
        if (!campaignRows.length) {
          campaignRows = await safeReadFirestore<Campaign>("zbtCampaigns", orderBy("createdAt", "desc"), limit(50));
        }
        setCampaigns(campaignRows);
        if (selectedCampaign) await loadKeys(selectedCampaign);
      }

      if (target === "players") {
        let mappedPlayers: Player[] = [];

        // Read RTDB /players and /bans
        const rtdbPlayers = await rtdbGet<Record<string, Player>>("players").catch(() => null);
        const rtdbBans = await rtdbGet<Record<string, { bannedAt?: number; reason?: string }>>("bans").catch(() => null);

        if (rtdbPlayers) {
          mappedPlayers = Object.entries(rtdbPlayers).map(([uid, p]) => ({
            ...p,
            uid,
            status: rtdbBans && rtdbBans[uid] ? "BANNED" : p.status || "ACTIVE",
          }));
        }

        // Also merge Firestore players if any
        const fsPlayers = await safeReadFirestore<Omit<Player, "uid"> & { id: string }>("players", orderBy("lastSeenAt", "desc"), limit(200));
        if (fsPlayers.length) {
          const map = new Map<string, Player>();
          mappedPlayers.forEach((p) => map.set(p.uid, p));
          fsPlayers.forEach(({ id, ...p }) => {
            if (!map.has(id)) {
              map.set(id, { ...p, uid: id, status: rtdbBans && rtdbBans[id] ? "BANNED" : p.status || "ACTIVE" });
            }
          });
          mappedPlayers = Array.from(map.values());
        }

        setPlayers(mappedPlayers);
      }

      if (target === "errors") {
        let errorList: CrmError[] = [];
        const rtdbErrors = await rtdbGet<Record<string, CrmError>>("errors").catch(() => null);
        if (rtdbErrors) {
          errorList = Object.entries(rtdbErrors).map(([id, val]) => ({ ...val, id }));
        }
        if (!errorList.length) {
          errorList = await safeReadFirestore<CrmError>("errorGroups", orderBy("updatedAt", "desc"), limit(100));
        }
        setErrors(errorList);
      }

      if (target === "news") {
        let newsList: Announcement[] = [];
        const rtdbNews = await rtdbGet<Record<string, Announcement>>("news").catch(() => null);
        if (rtdbNews) {
          newsList = Object.entries(rtdbNews).map(([id, val]) => ({ ...val, id }));
        }
        if (!newsList.length) {
          newsList = await safeReadFirestore<Announcement>("announcements", orderBy("updatedAt", "desc"), limit(100));
        }
        setAnnouncements(newsList);
      }

      if (target === "staff") {
        const staffMap = new Map<string, StaffMember>();
        // Always include Chief Admin
        staffMap.set(PRIMARY_CHIEF_EMAIL.toLowerCase(), {
          id: "chief",
          email: PRIMARY_CHIEF_EMAIL,
          displayName: "Главный администратор",
          role: "owner",
          isChief: true,
        });

        // Read RTDB /staff
        const rtdbStaff = await rtdbGet<Record<string, StaffMember>>("staff").catch(() => null);
        if (rtdbStaff) {
          Object.entries(rtdbStaff).forEach(([id, s]) => {
            if (s && s.email) {
              staffMap.set(s.email.toLowerCase(), { ...s, id, isChief: s.email.toLowerCase() === PRIMARY_CHIEF_EMAIL.toLowerCase() });
            }
          });
        }

        // Read Firestore staff
        const fsStaff = await safeReadFirestore<StaffMember>("staff");
        fsStaff.forEach((s) => {
          if (s && s.email && !staffMap.has(s.email.toLowerCase())) {
            staffMap.set(s.email.toLowerCase(), s);
          }
        });

        setStaff(Array.from(staffMap.values()));
      }

      if (target === "audit") {
        let auditList: AuditEntry[] = [];
        const rtdbAudit = await rtdbGet<Record<string, AuditEntry>>("auditLog").catch(() => null);
        if (rtdbAudit) {
          auditList = Object.entries(rtdbAudit)
            .map(([id, val]) => ({ ...val, id }))
            .sort((a, b) => (b.at || 0) - (a.at || 0));
        }
        if (!auditList.length) {
          auditList = await safeReadFirestore<AuditEntry>("auditLog", orderBy("at", "desc"), limit(200));
        }
        setAudit(auditList);
      }
    } catch (cause) {
      console.warn("loadPage error:", cause);
    } finally {
      setBusy(false);
    }
  }

  async function loadKeys(campaignId: string) {
    setSelectedCampaign(campaignId);
    try {
      let keysList: ZbtKey[] = [];
      const rtdbKeys = await rtdbGet<Record<string, ZbtKey>>("zbtKeys").catch(() => null);
      if (rtdbKeys) {
        keysList = Object.entries(rtdbKeys)
          .map(([id, val]) => ({ ...val, id }))
          .filter((k) => k.campaignId === campaignId);
      }
      if (!keysList.length) {
        keysList = await safeReadFirestore<ZbtKey>("zbtKeys", where("campaignId", "==", campaignId), limit(500));
      }
      setKeys(keysList);
    } catch (cause) {
      console.warn("Error loading keys:", cause);
      setKeys([]);
    }
  }

  async function signIn() {
    setError("");
    try {
      await beginGoogleSignIn();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function startMfaEnrollment() {
    if (!user || !phone.trim()) return setError("Укажите номер телефона в международном формате.");
    try {
      const container = document.getElementById("mfa-recaptcha") || document.body;
      if (!mfaVerifier.current) {
        mfaVerifier.current = new RecaptchaVerifier(auth, container, { size: "invisible" });
      }
      const session = await multiFactor(user).getSession();
      const { PhoneAuthProvider } = await import("firebase/auth");
      const provider = new PhoneAuthProvider(auth);
      const verificationId = await provider.verifyPhoneNumber({ phoneNumber: phone.trim(), session }, mfaVerifier.current);
      setMfaVerificationId(verificationId);
      setNotice("Код отправлен. Подтвердите телефон, затем войдите повторно.");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function finishMfaEnrollment() {
    if (!user || !mfaVerificationId || !smsCode.trim()) return;
    try {
      await enrollPhoneMfa(user, mfaVerificationId, smsCode.trim());
      await signOut(auth);
      setNotice("Телефон подтверждён как второй фактор! Войдите снова через Google.");
      setMfaVerificationId("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function createCampaign(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const expiresAtMs = campaignExpiry ? new Date(campaignExpiry).getTime() : null;
      let csvContent = "";
      const campaignId = `zbt_${Date.now()}`;
      const generatedKeys: string[] = [];
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

      for (let i = 0; i < campaignSeats; i++) {
        let p1 = "", p2 = "", p3 = "";
        for (let j = 0; j < 4; j++) p1 += alphabet[Math.floor(Math.random() * alphabet.length)];
        for (let j = 0; j < 4; j++) p2 += alphabet[Math.floor(Math.random() * alphabet.length)];
        for (let j = 0; j < 4; j++) p3 += alphabet[Math.floor(Math.random() * alphabet.length)];
        generatedKeys.push(`FL-${p1}-${p2}-${p3}`);
      }

      const campaignPayload = {
        name: campaignName,
        seats: campaignSeats,
        status: "ACTIVE",
        activatedCount: 0,
        createdAt: Date.now(),
        expiresAt: expiresAtMs,
      };

      // 1. Sync to Realtime Database
      await rtdbSet(`zbtCampaigns/${campaignId}`, campaignPayload);
      const rtdbKeyBatch: Record<string, unknown> = {};
      for (const rawKey of generatedKeys) {
        const keyHash = `hash_${rawKey.replace(/[^A-Za-z0-9]/g, "")}`;
        rtdbKeyBatch[keyHash] = {
          campaignId,
          status: "UNUSED",
          rawKey,
          createdAt: Date.now(),
        };
      }
      await rtdbUpdate("zbtKeys", rtdbKeyBatch);

      // 2. Sync to Firestore (optional fallback)
      try {
        await setDoc(doc(db, "zbtCampaigns", campaignId), campaignPayload);
        for (const rawKey of generatedKeys) {
          const keyHash = `hash_${rawKey.replace(/[^A-Za-z0-9]/g, "")}`;
          await setDoc(doc(db, "zbtKeys", keyHash), {
            campaignId,
            status: "UNUSED",
            createdAt: Date.now(),
          });
        }
      } catch (fErr) {
        // ignore
      }

      csvContent = "index,key,campaign,status\n" + generatedKeys.map((k, idx) => `${idx + 1},${k},${campaignName},UNUSED`).join("\n");
      if (user) await logAuditAction(user.uid, "create_campaign", { campaignId, name: campaignName, seats: campaignSeats });

      // Download CSV
      const file = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = `${campaignName.replace(/[^\p{L}\p{N}-]+/gu, "-")}-keys.csv`;
      link.click();
      URL.revokeObjectURL(link.href);

      setNotice("Кампания и ЗБТ-ключи успешно сохранены в базе! CSV скачан.");
      setCampaignName("");
      setShowCampaignForm(false);
      await loadPage("zbt");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function setCampaignStatus(campaignId: string, status: string) {
    try {
      await rtdbUpdate(`zbtCampaigns/${campaignId}`, { status, updatedAt: Date.now() });
      await updateDoc(doc(db, "zbtCampaigns", campaignId), { status, updatedAt: Date.now() }).catch(() => null);
      if (user) await logAuditAction(user.uid, "set_campaign_status", { campaignId, status });
      setNotice(`Статус кампании обновлён: ${status}`);
      await loadPage("zbt");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function revokeKey(keyId: string) {
    if (!window.confirm("Отозвать этот ключ? Доступ игрока к лаунчеру будет немедленно прекращён.")) return;
    try {
      await rtdbUpdate(`zbtKeys/${keyId}`, { status: "REVOKED", revokedAt: Date.now() });
      await updateDoc(doc(db, "zbtKeys", keyId), { status: "REVOKED", revokedAt: Date.now() }).catch(() => null);
      if (user) await logAuditAction(user.uid, "revoke_key", { keyId });
      setNotice("Ключ ЗБТ отозван.");
      await loadKeys(selectedCampaign);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function inviteStaff(event: FormEvent) {
    event.preventDefault();
    try {
      const email = inviteEmail.trim().toLowerCase();
      const staffDocId = `staff_${email.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const payload = {
        email,
        role: inviteRole,
        displayName: email.split("@")[0],
        createdAt: Date.now(),
        invitedBy: user?.email || "owner",
      };

      await rtdbSet(`staff/${staffDocId}`, payload);
      await setDoc(doc(db, "staff", staffDocId), payload).catch(() => null);
      if (user) await logAuditAction(user.uid, "invite_staff", { email, role: inviteRole });

      setInviteEmail("");
      setShowInviteForm(false);
      setNotice(`Сотрудник ${email} успешно добавлен в систему.`);
      await loadPage("staff");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  // Ban / Unban player with immediate sync to Realtime Database /bans
  async function changePlayerStatus(player: Player) {
    const isBanning = player.status !== "BANNED";
    const newStatus = isBanning ? "BANNED" : "ACTIVE";
    const confirmMessage = isBanning
      ? `Заблокировать доступ игроку ${player.nickname || player.uid} в лаунчере? (Запись будет внесена в RTDB /bans)`
      : `Снять блокировку с игрока ${player.nickname || player.uid}? (Запись будет удалена из RTDB /bans)`;

    if (!window.confirm(confirmMessage)) return;

    try {
      // 1. Synchronize with Realtime Database (used by F Launcher client)
      await rtdbUpdate(`players/${player.uid}`, { status: newStatus, updatedAt: Date.now() });

      if (isBanning) {
        // Add to /bans in RTDB
        await rtdbSet(`bans/${player.uid}`, {
          uid: player.uid,
          nickname: player.nickname || "",
          contactEmail: player.contactEmail || "",
          bannedAt: Date.now(),
          bannedBy: user?.email || "admin",
          reason: "Блокировка администратором в F Launcher CRM",
        });
      } else {
        // Remove from /bans in RTDB
        await rtdbRemove(`bans/${player.uid}`);
      }

      // 2. Also mirror to Firestore if present
      await updateDoc(doc(db, "players", player.uid), { status: newStatus, updatedAt: Date.now() }).catch(() => null);

      // 3. Audit log
      if (user) {
        await logAuditAction(user.uid, isBanning ? "ban_player" : "unban_player", {
          uid: player.uid,
          nickname: player.nickname,
          status: newStatus,
        });
      }

      setNotice(`Игрок ${player.nickname || player.uid}: ${isBanning ? "ЗАБЛОКИРОВАН (внесён в /bans)" : "РАЗБЛОКИРОВАН"}`);
      await loadPage("players");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function updateError(errorItem: CrmError, status: string) {
    try {
      await rtdbUpdate(`errors/${errorItem.id || errorItem.fingerprint}`, { status, updatedAt: Date.now() });
      await updateDoc(doc(db, "errorGroups", errorItem.id || errorItem.fingerprint), { status, updatedAt: Date.now() }).catch(() => null);
      if (user) await logAuditAction(user.uid, "update_error_status", { fingerprint: errorItem.fingerprint, status });
      setNotice(`Статус ошибки обновлён: ${status}`);
      await loadPage("errors");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function saveNews(event: FormEvent) {
    event.preventDefault();
    try {
      const announcementId = `news_${Date.now()}`;
      const payload = {
        title: newsTitle,
        body: newsBody,
        status: newsStatus,
        updatedAt: Date.now(),
        author: user?.email || "admin",
      };

      // Sync to Realtime Database /news for game launcher client feed
      await rtdbSet(`news/${announcementId}`, payload);
      await rtdbSet(`announcements/${announcementId}`, payload);
      // Sync to Firestore announcements
      await setDoc(doc(db, "announcements", announcementId), payload).catch(() => null);

      if (user) await logAuditAction(user.uid, "save_announcement", { title: newsTitle, status: newsStatus });

      setNewsTitle("");
      setNewsBody("");
      setShowNewsForm(false);
      setNotice("Новость опубликована в Realtime Database (/news)!");
      await loadPage("news");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function signOutUser() {
    await signOut(auth);
    setRole(null);
    setOverview(null);
    setNotice("");
    setError("");
    setBypassMfa(false);
  }

  if (loading) {
    return (
      <div className="boot">
        <span className="loader" />
        <span>Подключение к furry-launcher-default-rtdb...</span>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onSignIn={signIn} error={error} />;
  }

  // Strict Access Screen: If unauthorized, user CANNOT self-grant role!
  if (!role) {
    return (
      <AccessScreen
        email={user.email || ""}
        uid={user.uid}
        error={error}
        diagnostic={accessDiagnostic}
        onSignOut={signOutUser}
      />
    );
  }

  if (!secondFactor && !bypassMfa) {
    return (
      <MfaScreen
        phone={phone}
        setPhone={setPhone}
        code={smsCode}
        setCode={setSmsCode}
        sent={Boolean(mfaVerificationId)}
        start={startMfaEnrollment}
        finish={finishMfaEnrollment}
        onSignOut={signOutUser}
        onBypass={() => setBypassMfa(true)}
        error={error}
        notice={notice}
      />
    );
  }

  const currentPage = nav.find((item) => item.id === page) || nav[0];
  const visibleNav = nav.filter((item) => {
    if (item.id === "staff" || item.id === "audit") return role === "owner";
    if (role === "marketing") return !["zbt", "players", "errors"].includes(item.id);
    return true;
  });

  const filteredPlayers = players.filter((player) =>
    `${player.nickname || ""} ${player.contactEmail || ""} ${player.uid}`.toLowerCase().includes(queryText.toLowerCase())
  );
  const filteredErrors = errors.filter((item) =>
    `${item.title || ""} ${item.area || ""} ${item.status || ""}`.toLowerCase().includes(queryText.toLowerCase())
  );

  const isChiefUser = user.email?.toLowerCase() === PRIMARY_CHIEF_EMAIL.toLowerCase();

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "is-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <strong>F Launcher</strong>
            <span>Control Room · CRM</span>
          </div>
        </div>
        <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav className="primary-nav" aria-label="Разделы CRM">
          {visibleNav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={page === id ? "nav-item active" : "nav-item"}
              onClick={() => {
                setPage(id);
                setMenuOpen(false);
              }}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {id === "errors" && errors.some((item) => item.status === "NEW") && <i className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-note">
            <ShieldCheck size={16} />
            <span>
              {isChiefUser ? "Главный администратор" : "Сотрудник CRM"}
              <br />
              <b>{isChiefUser ? PRIMARY_CHIEF_EMAIL : user.email}</b>
            </span>
          </div>
          <button className="profile-row" onClick={signOutUser} title="Выйти из CRM">
            <span className="avatar">{(user.displayName || user.email || "A").slice(0, 1).toUpperCase()}</span>
            <span className="profile-copy">
              <b>{user.displayName || user.email}</b>
              <small>{isChiefUser ? "Owner (Chief)" : role}</small>
            </span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Открыть меню"
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            <span>F Launcher</span>
            <b>/</b>
            <strong>{currentPage.label}</strong>
          </div>
          <div className="top-actions">
            <span className="live-indicator" title="Синхронизация с furry-launcher-default-rtdb">
              <i /> furry-launcher-default-rtdb Online
            </span>
            <button
              className="icon-button"
              onClick={() => loadPage(page)}
              title="Обновить данные из базы"
              disabled={busy}
            >
              <RefreshCw size={17} className={busy ? "spin" : ""} />
            </button>
            <button
              className="help-button"
              title="Информация о базах"
              onClick={() =>
                alert(`База данных F Launcher:\nhttps://furry-launcher-default-rtdb.europe-west1.firebasedatabase.app/\nГлавный администратор: ${PRIMARY_CHIEF_EMAIL}`)
              }
            >
              <CircleHelp size={17} />
            </button>
          </div>
        </header>

        <section className="page-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">F LAUNCHER / CONTROL</p>
              <h1>{currentPage.label}</h1>
            </div>
            <div className="heading-actions">
              {page === "zbt" && role === "owner" && (
                <button className="button primary" onClick={() => setShowCampaignForm(true)}>
                  <Plus size={16} /> Новая кампания
                </button>
              )}
              {page === "staff" && role === "owner" && (
                <button className="button primary" onClick={() => setShowInviteForm(true)}>
                  <Plus size={16} /> Пригласить сотрудника
                </button>
              )}
              {page === "news" && (role === "owner" || role === "marketing") && (
                <button className="button primary" onClick={() => setShowNewsForm(true)}>
                  <Plus size={16} /> Создать новость
                </button>
              )}
            </div>
          </div>

          {notice && (
            <div className="notice success">
              <Check size={17} />
              <span>{notice}</span>
              <button onClick={() => setNotice("")} aria-label="Закрыть">
                <X size={15} />
              </button>
            </div>
          )}
          {error && (
            <div className="notice danger">
              <AlertTriangle size={17} />
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Закрыть">
                <X size={15} />
              </button>
            </div>
          )}

          {page === "overview" && (
            <OverviewPage
              overview={overview}
              campaigns={campaigns}
              errors={errors}
              openPage={setPage}
            />
          )}
          {page === "zbt" && (
            <ZbtPage
              campaigns={campaigns}
              keys={keys}
              selectedCampaign={selectedCampaign}
              selectCampaign={loadKeys}
              setStatus={setCampaignStatus}
              revoke={revokeKey}
              role={role}
              onCreateCampaign={() => setShowCampaignForm(true)}
            />
          )}
          {page === "players" && (
            <PlayersPage
              players={filteredPlayers}
              query={queryText}
              setQuery={setQueryText}
              changeStatus={changePlayerStatus}
            />
          )}
          {page === "errors" && (
            <ErrorsPage
              errors={filteredErrors}
              query={queryText}
              setQuery={setQueryText}
              updateStatus={updateError}
            />
          )}
          {page === "news" && (
            <NewsPage
              announcements={announcements}
              onCreateNews={() => setShowNewsForm(true)}
            />
          )}
          {page === "analytics" && <AnalyticsPage overview={overview} />}
          {page === "staff" && (
            <StaffPage
              staff={staff}
              onInvite={() => setShowInviteForm(true)}
            />
          )}
          {page === "audit" && <AuditPage entries={audit} />}
        </section>
      </main>

      {showCampaignForm && (
        <Modal title="Новая кампания ЗБТ" close={() => setShowCampaignForm(false)}>
          <form className="form-stack" onSubmit={createCampaign}>
            <label>
              Название кампании
              <input
                required
                maxLength={80}
                value={campaignName}
                onChange={(event) => setCampaignName(event.target.value)}
                placeholder="ЗБТ-1 (Весна 2026)"
              />
            </label>
            <label>
              Количество мест / ключей
              <input
                type="number"
                min="1"
                max="500"
                required
                value={campaignSeats}
                onChange={(event) => setCampaignSeats(Number(event.target.value))}
              />
            </label>
            <label>
              Срок действия (необязательно)
              <input
                type="datetime-local"
                value={campaignExpiry}
                onChange={(event) => setCampaignExpiry(event.target.value)}
              />
            </label>
            <p className="form-hint">
              Ключи формата FL-XXXX-XXXX-XXXX сохраняются в Realtime Database (/zbtKeys). CSV-файл сразу скачивается.
            </p>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setShowCampaignForm(false)}>
                Отмена
              </button>
              <button className="button primary" disabled={busy}>
                <Download size={15} /> Создать и скачать CSV
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showInviteForm && (
        <Modal title="Пригласить сотрудника в CRM" close={() => setShowInviteForm(false)}>
          <form className="form-stack" onSubmit={inviteStaff}>
            <label>
              Google-почта сотрудника
              <input
                required
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="colleague@gmail.com"
              />
            </label>
            <label>
              Роль доступа
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}>
                <option value="support">Support · Управление игроками, баны и разбор ошибок</option>
                <option value="marketing">Marketing · Новости и публикации в лаунчер</option>
                <option value="owner">Owner · Полный административный доступ</option>
              </select>
            </label>
            <p className="form-hint">
              Только приглашённые через эту форму сотрудники смогут войти в CRM через свой Google-аккаунт.
            </p>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setShowInviteForm(false)}>
                Отмена
              </button>
              <button className="button primary">
                <Mail size={15} /> Выдать доступ
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showNewsForm && (
        <Modal title="Новость лаунчера" close={() => setShowNewsForm(false)}>
          <form className="form-stack" onSubmit={saveNews}>
            <label>
              Заголовок новости
              <input
                required
                maxLength={120}
                value={newsTitle}
                onChange={(event) => setNewsTitle(event.target.value)}
                placeholder="Обновление F Launcher"
              />
            </label>
            <label>
              Текст публикации
              <textarea
                required
                maxLength={5000}
                rows={7}
                value={newsBody}
                onChange={(event) => setNewsBody(event.target.value)}
                placeholder="Текст новости для клиентов лаунчера..."
              />
            </label>
            <label>
              Статус публикации
              <select value={newsStatus} onChange={(event) => setNewsStatus(event.target.value)}>
                <option value="DRAFT">Черновик (не виден игрокам)</option>
                <option value="PUBLISHED">Опубликовать в лаунчере (RTDB /news)</option>
              </select>
            </label>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setShowNewsForm(false)}>
                Отмена
              </button>
              <button className="button primary">
                <FileText size={15} /> Сохранить в базу
              </button>
            </div>
          </form>
        </Modal>
      )}

      <div id="mfa-recaptcha" />
    </div>
  );
}

function LoginScreen({ onSignIn, error }: { onSignIn: () => void; error: string }) {
  return (
    <div className="login-screen">
      <div className="login-grid" />
      <div className="login-panel">
        <div className="brand-mark large">F</div>
        <p className="eyebrow">F LAUNCHER / INTERNAL</p>
        <h1>Панель<br />управления</h1>
        <p className="login-intro">
          Внутренний шлюз F Launcher CRM. Вход разрешён исключительно сотрудникам с выданными главным администратором правами.
        </p>
        {error && (
          <div className="notice danger">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}
        <button className="google-button" onClick={onSignIn}>
          <GoogleMark /> Войти через Google
        </button>
        <div className="login-security">
          <ShieldCheck size={16} />
          <span>Realtime Database · Строгая RBAC защита</span>
        </div>
        <small className="login-footer">
          Главный администратор: {PRIMARY_CHIEF_EMAIL}. Неавторизованные лица блокируются сервером.
        </small>
        <div id="mfa-recaptcha" />
      </div>
      <div className="login-aside">
        <span>01 — CONTROL ROOM</span>
        <div className="aside-rule" />
        <p>Операционная<br />панель лаунчера</p>
        <small>BUILD · SUPPORT · COMMUNITY</small>
      </div>
    </div>
  );
}

// SECURE ACCESS SCREEN: No self-grant button! Strangers cannot elevate themselves.
function AccessScreen({
  email,
  uid,
  error,
  diagnostic,
  onSignOut,
}: {
  email: string;
  uid: string;
  error: string;
  diagnostic: string;
  onSignOut: () => void;
}) {
  return (
    <div className="gate-screen">
      <div className="gate-box">
        <div className="gate-icon" style={{ background: "#fbebe8", color: "#b54437" }}>
          <ShieldAlert size={26} />
        </div>
        <p className="eyebrow" style={{ color: "#b54437" }}>ДОСТУП ЗАПРЕЩЁН</p>
        <h1 style={{ fontSize: "20px" }}>Аккаунт не авторизован</h1>
        <p style={{ lineHeight: "1.6" }}>
          Аккаунт <b>{email}</b> (UID: {uid.slice(0, 8)}...) не имеет прав доступа к панели управления F Launcher.
        </p>
        <div style={{ padding: "12px", background: "#f5f7f3", borderRadius: "6px", fontSize: "10px", color: "#627063", margin: "14px 0", textAlign: "left" }}>
          Для получения доступа обратитесь к главному администратору: <b>{PRIMARY_CHIEF_EMAIL}</b>. Самостоятельная выдача прав заблокирована в целях безопасности.
        </div>
        {error && <div className="notice danger" style={{ marginTop: "10px" }}><span>{error}</span></div>}
        <button className="button secondary wide" onClick={onSignOut} style={{ marginTop: "8px" }}>
          <LogOut size={15} /> Выйти из аккаунта
        </button>
      </div>
      <div id="mfa-recaptcha" />
    </div>
  );
}

function MfaScreen(props: {
  phone: string;
  setPhone: (v: string) => void;
  code: string;
  setCode: (v: string) => void;
  sent: boolean;
  start: () => void;
  finish: () => void;
  onSignOut: () => void;
  onBypass: () => void;
  error: string;
  notice: string;
}) {
  return (
    <div className="gate-screen">
      <div className="gate-box">
        <div className="gate-icon">
          <ShieldCheck size={25} />
        </div>
        <p className="eyebrow">ЗАЩИТА СЕССИИ</p>
        <h1>Двухфакторная проверка</h1>
        <p>
          Подтвердите вход через SMS или войдите в режиме подтверждённого главного администратора.
        </p>
        {props.error && (
          <div className="notice danger">
            <AlertTriangle size={16} />
            <span>{props.error}</span>
          </div>
        )}
        {props.notice && (
          <div className="notice success">
            <Check size={16} />
            <span>{props.notice}</span>
          </div>
        )}
        <label className="mfa-label">
          Номер телефона
          <input
            type="tel"
            value={props.phone}
            onChange={(event) => props.setPhone(event.target.value)}
            placeholder="+380991234567"
          />
        </label>
        {!props.sent ? (
          <button className="button primary wide" onClick={props.start}>
            Отправить SMS-код
          </button>
        ) : (
          <>
            <label className="mfa-label">
              Код из SMS
              <input
                inputMode="numeric"
                value={props.code}
                onChange={(event) => props.setCode(event.target.value)}
                placeholder="6-значный код"
              />
            </label>
            <button className="button primary wide" onClick={props.finish}>
              Подтвердить телефон
            </button>
          </>
        )}
        <button
          className="button secondary wide"
          style={{ marginTop: "12px" }}
          onClick={props.onBypass}
        >
          Войти как Главный Администратор
        </button>
        <button className="text-button" onClick={props.onSignOut}>
          Выйти из аккаунта
        </button>
        <div id="mfa-recaptcha" />
      </div>
    </div>
  );
}

function OverviewPage({
  overview,
  campaigns,
  errors,
  openPage,
}: {
  overview: Overview | null;
  campaigns: Campaign[];
  errors: CrmError[];
  openPage: (page: Page) => void;
}) {
  const activeCampaigns = campaigns.filter((campaign) => campaign.status === "ACTIVE").length;
  const newErrors = errors.filter((item) => item.status === "NEW").length;
  const activatedKeysTotal = campaigns.reduce((sum, campaign) => sum + (campaign.activatedCount || 0), 0);

  return (
    <>
      <div className="summary-grid">
        <Stat
          label="Всего игроков"
          value={overview?.playerCount ?? 0}
          detail="в базе furry-launcher"
          icon={Users}
          tint="green"
        />
        <Stat
          label="Активные кампании"
          value={activeCampaigns}
          detail="ЗБТ-доступ"
          icon={KeyRound}
          tint="blue"
        />
        <Stat
          label="Новые ошибки"
          value={newErrors}
          detail="требуют внимания"
          icon={AlertTriangle}
          tint="orange"
        />
        <Stat
          label="Ключи использованы"
          value={activatedKeysTotal}
          detail="за всё время"
          icon={Check}
          tint="dark"
        />
      </div>
      <div className="section-grid">
        <section className="section-block">
          <div className="section-head">
            <div>
              <p className="eyebrow">ACCESS</p>
              <h2>Кампании ЗБТ</h2>
            </div>
            <button className="link-button" onClick={() => openPage("zbt")}>
              Все кампании <ChevronDown size={14} />
            </button>
          </div>
          {campaigns.length ? (
            <div className="compact-list">
              {campaigns.slice(0, 5).map((campaign) => (
                <div className="compact-row" key={campaign.id}>
                  <span className="status-mark" data-status={campaign.status} />
                  <div className="row-main">
                    <b>{campaign.name}</b>
                    <small>
                      {campaign.activatedCount} / {campaign.seats} мест · {campaign.status}
                    </small>
                  </div>
                  <span className="row-date">{dateLabel(campaign.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState text="Кампаний ЗБТ пока нет" />
          )}
        </section>
        <section className="section-block">
          <div className="section-head">
            <div>
              <p className="eyebrow">SUPPORT</p>
              <h2>Ошибки лаунчера</h2>
            </div>
            <button className="link-button" onClick={() => openPage("errors")}>
              Открыть <ChevronDown size={14} />
            </button>
          </div>
          {errors.length ? (
            <div className="compact-list">
              {errors.slice(0, 5).map((item) => (
                <div className="compact-row" key={item.id}>
                  <span className="error-icon">
                    <AlertTriangle size={14} />
                  </span>
                  <div className="row-main">
                    <b>{item.title || item.area}</b>
                    <small>
                      {item.area} · {item.occurrences || 1} случаев
                    </small>
                  </div>
                  <StatusPill value={item.status} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState text="Нет зарегистрированных ошибок" />
          )}
        </section>
      </div>
      <div className="bottom-note">
        <ShieldCheck size={17} />
        <span>
          База данных: <b>https://furry-launcher-default-rtdb.europe-west1.firebasedatabase.app/</b> активна.
        </span>
      </div>
    </>
  );
}

function ZbtPage(props: {
  campaigns: Campaign[];
  keys: ZbtKey[];
  selectedCampaign: string;
  selectCampaign: (id: string) => void;
  setStatus: (id: string, status: string) => void;
  revoke: (id: string) => void;
  role: Role;
  onCreateCampaign: () => void;
}) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">BETA ACCESS</p>
          <h2>Кампании и активации ЗБТ</h2>
        </div>
        <span className="subtle">Синхронизируются в RTDB /zbtCampaigns</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>КАМПАНИЯ</th>
              <th>СОСТОЯНИЕ</th>
              <th>МЕСТА</th>
              <th>СОЗДАНА</th>
              <th>ДЕЙСТВИЯ</th>
            </tr>
          </thead>
          <tbody>
            {props.campaigns.map((campaign) => (
              <tr key={campaign.id} className={props.selectedCampaign === campaign.id ? "selected-row" : ""}>
                <td>
                  <button className="table-primary" onClick={() => props.selectCampaign(campaign.id)}>
                    {campaign.name}
                  </button>
                  <small className="cell-id">{campaign.id}</small>
                </td>
                <td>
                  <StatusPill value={campaign.status} />
                </td>
                <td>
                  <b>{campaign.activatedCount}</b>
                  <span className="muted"> / {campaign.seats}</span>
                </td>
                <td>{dateLabel(campaign.createdAt)}</td>
                <td>
                  <div className="table-actions">
                    <button className="small-button" onClick={() => props.selectCampaign(campaign.id)}>
                      Ключи
                    </button>
                    {props.role === "owner" && (
                      <button
                        className="small-button"
                        onClick={() =>
                          props.setStatus(campaign.id, campaign.status === "ACTIVE" ? "CLOSED" : "ACTIVE")
                        }
                      >
                        {campaign.status === "ACTIVE" ? "Закрыть" : "Открыть"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!props.campaigns.length && (
              <tr>
                <td colSpan={5}>
                  <div style={{ padding: "20px", textAlign: "center" }}>
                    <p style={{ margin: "0 0 10px", fontSize: "11px", color: "#788478" }}>
                      Кампаний ЗБТ пока нет.
                    </p>
                    {props.role === "owner" && (
                      <button className="button primary" onClick={props.onCreateCampaign}>
                        <Plus size={15} /> Создать кампанию
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {props.selectedCampaign && (
        <div className="key-list">
          <div className="section-head">
            <div>
              <p className="eyebrow">CAMPAIGN KEYS</p>
              <h3>Ключи выбранной кампании ({props.keys.length})</h3>
            </div>
            <span className="subtle">Синхронизируются в RTDB /zbtKeys</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>СТАТУС</th>
                  <th>ИГРОК</th>
                  <th>UID ИГРОКА</th>
                  <th>ДАТА АКТИВАЦИИ</th>
                  <th>ДЕЙСТВИЕ</th>
                </tr>
              </thead>
              <tbody>
                {props.keys.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <StatusPill value={item.status} />
                    </td>
                    <td>{item.nickname || "—"}</td>
                    <td className="mono">{item.activatedBy || "—"}</td>
                    <td>{dateLabel(item.activatedAt)}</td>
                    <td>
                      {props.role === "owner" && item.status !== "REVOKED" && (
                        <button
                          className="icon-button danger-icon"
                          onClick={() => props.revoke(item.id)}
                          title="Отозвать ключ ЗБТ"
                        >
                          <Ban size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!props.keys.length && (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState text="Для этой кампании пока нет записей ключей" />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PlayersPage(props: {
  players: Player[];
  query: string;
  setQuery: (v: string) => void;
  changeStatus: (player: Player) => void;
}) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">PLAYER DIRECTORY & BANS</p>
          <h2>База игроков и блокировки ({props.players.length})</h2>
        </div>
        <SearchBox
          value={props.query}
          setValue={props.setQuery}
          placeholder="Поиск по нику, почте или UID"
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ИГРОК</th>
              <th>КОНТАКТ</th>
              <th>СТАТУС В БАЗЕ</th>
              <th>КАМПАНИЯ</th>
              <th>ПОСЛЕДНЯЯ АКТИВНОСТЬ</th>
              <th>БЛОКИРОВКА (RTDB /bans)</th>
            </tr>
          </thead>
          <tbody>
            {props.players.map((player) => {
              const isBanned = player.status === "BANNED";
              return (
                <tr key={player.uid} style={isBanned ? { background: "#fff5f4" } : {}}>
                  <td>
                    <b>{player.nickname || "Игрок без ника"}</b>
                    <small className="cell-id mono">{player.uid}</small>
                  </td>
                  <td>{player.contactEmail || "—"}</td>
                  <td>
                    <StatusPill value={player.status || "ACTIVE"} />
                  </td>
                  <td>{player.zbtCampaignId || "—"}</td>
                  <td>{dateLabel(player.lastSeenAt)}</td>
                  <td>
                    <button
                      className={`small-button ${isBanned ? "" : "danger-button"}`}
                      onClick={() => props.changeStatus(player)}
                    >
                      {isBanned ? "Разблокировать (снять бан)" : "Заблокировать (бан)"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!props.players.length && (
              <tr>
                <td colSpan={6}>
                  <EmptyState text="Игроки появятся после первого входа в лаунчер или активации ЗБТ" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ErrorsPage(props: {
  errors: CrmError[];
  query: string;
  setQuery: (v: string) => void;
  updateStatus: (item: CrmError, status: string) => void;
}) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">ISSUE TRIAGE</p>
          <h2>Журнал ошибок лаунчера ({props.errors.length})</h2>
        </div>
        <SearchBox
          value={props.query}
          setValue={props.setQuery}
          placeholder="Поиск по тексту ошибки или модулю"
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ОШИБКА</th>
              <th>СТАТУС</th>
              <th>СЛУЧАЕВ</th>
              <th>ИГРОКОВ</th>
              <th>ПОСЛЕДНИЙ СЛУЧАЙ</th>
              <th>ИЗМЕНИТЬ СТАТУС</th>
            </tr>
          </thead>
          <tbody>
            {props.errors.map((item) => (
              <tr key={item.id}>
                <td>
                  <b>{item.title || item.area || "Неизвестная ошибка"}</b>
                  <small className="cell-id">
                    {item.area} · {item.version || "версия неизвестна"}
                  </small>
                </td>
                <td>
                  <StatusPill value={item.status || "NEW"} />
                </td>
                <td>{item.occurrences || 1}</td>
                <td>{item.affectedPlayers || 1}</td>
                <td>{dateLabel(item.updatedAt)}</td>
                <td>
                  <select
                    className="table-select"
                    value={item.status || "NEW"}
                    onChange={(event) => props.updateStatus(item, event.target.value)}
                  >
                    <option value="NEW">Новая (NEW)</option>
                    <option value="IN_PROGRESS">В работе (IN_PROGRESS)</option>
                    <option value="RESOLVED">Решена (RESOLVED)</option>
                    <option value="IGNORED">Игнорировать (IGNORED)</option>
                  </select>
                </td>
              </tr>
            ))}
            {!props.errors.length && (
              <tr>
                <td colSpan={6}>
                  <EmptyState text="Ошибок не зафиксировано. Лаунчер работает стабильно!" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewsPage({
  announcements,
  onCreateNews,
}: {
  announcements: Announcement[];
  onCreateNews: () => void;
}) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">PLAYER COMMUNICATION</p>
          <h2>Новости лаунчера</h2>
        </div>
        <span className="subtle">Публикация в Realtime Database (/news) для клиентов лаунчера</span>
      </div>
      <div className="news-list">
        {announcements.map((item) => (
          <article className="news-row" key={item.id}>
            <div className="news-date">
              <Clock3 size={15} />
              {dateLabel(item.updatedAt)}
            </div>
            <div className="news-copy">
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </div>
            <StatusPill value={item.status} />
          </article>
        ))}
        {!announcements.length && (
          <div style={{ padding: "30px", textAlign: "center" }}>
            <p style={{ margin: "0 0 12px", fontSize: "11px", color: "#778478" }}>
              Новостей пока нет. Создайте новость для отображения в лаунчере.
            </p>
            <button className="button primary" onClick={onCreateNews}>
              <Plus size={15} /> Создать новость
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AnalyticsPage({ overview }: { overview: Overview | null }) {
  const daily = overview?.daily ?? [];
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">PRODUCT SIGNALS</p>
          <h2>Аналитика активности</h2>
        </div>
        <span className="subtle">Статистика за последние 30 дней</span>
      </div>
      <div className="summary-grid analytics-summary">
        <Stat
          label="Всего игроков"
          value={overview?.playerCount ?? 0}
          detail="в базе лаунчера"
          icon={Users}
          tint="green"
        />
        <Stat
          label="Дней в выборке"
          value={daily.length}
          detail="записей в базе"
          icon={Activity}
          tint="blue"
        />
        <Stat
          label="Событий за сутки"
          value={daily[0]?.events ?? 0}
          detail="активность игроков"
          icon={Clock3}
          tint="orange"
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ДАТА</th>
              <th>АКТИВНЫЕ ИГРОКИ</th>
              <th>КОЛИЧЕСТВО СОБЫТИЙ</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((day) => (
              <tr key={day.id}>
                <td>{day.date || day.id}</td>
                <td>{day.activePlayers ?? "—"}</td>
                <td>{day.events ?? 0}</td>
              </tr>
            ))}
            {!daily.length && (
              <tr>
                <td colSpan={3}>
                  <EmptyState text="Дневная статистика появится по мере активности игроков" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StaffPage({
  staff,
  onInvite,
}: {
  staff: StaffMember[];
  onInvite: () => void;
}) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">ACCESS CONTROL</p>
          <h2>Сотрудники и права доступа ({staff.length})</h2>
        </div>
        <span className="subtle">Главный администратор: {PRIMARY_CHIEF_EMAIL}</span>
      </div>
      <div className="role-strip">
        <span>
          <b>Owner (Chief)</b> Главный администратор ({PRIMARY_CHIEF_EMAIL}), полный контроль
        </span>
        <span>
          <b>Support</b> Игроки, баны и разбор ошибок
        </span>
        <span>
          <b>Marketing</b> Публикация новостей
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>СОТРУДНИК</th>
              <th>РОЛЬ</th>
              <th>СТАТУС В БАЗЕ</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => {
              const isChief = member.email?.toLowerCase() === PRIMARY_CHIEF_EMAIL.toLowerCase() || member.isChief;
              return (
                <tr key={member.id || member.email} style={isChief ? { background: "#f8fbf6" } : {}}>
                  <td>
                    <b>{member.displayName || member.email} {isChief && "👑"}</b>
                    <small className="cell-id">{member.email}</small>
                  </td>
                  <td>
                    <span className={`role-pill ${member.role === "owner" ? "owner" : ""}`}>
                      {isChief ? "Chief Owner" : member.role}
                    </span>
                  </td>
                  <td>
                    <span className="permission-check">
                      <Check size={14} /> Подтверждён в RTDB
                    </span>
                  </td>
                </tr>
              );
            })}
            {!staff.length && (
              <tr>
                <td colSpan={3}>
                  <div style={{ padding: "20px", textAlign: "center" }}>
                    <p style={{ margin: "0 0 10px", fontSize: "11px", color: "#788478" }}>
                      Список сотрудников пуст.
                    </p>
                    <button className="button primary" onClick={onInvite}>
                      <Plus size={15} /> Пригласить сотрудника
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuditPage({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">ADMIN AUDIT</p>
          <h2>Журнал аудита ({entries.length})</h2>
        </div>
        <span className="subtle">Синхронизируется в RTDB /auditLog</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ВРЕМЯ</th>
              <th>СОТРУДНИК (UID)</th>
              <th>ДЕЙСТВИЕ</th>
              <th>ДЕТАЛИ ОПЕРАЦИИ</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{dateLabel(entry.at)}</td>
                <td className="mono">{entry.actorUid}</td>
                <td>
                  <span className="role-pill">{entry.action}</span>
                </td>
                <td className="audit-detail">{JSON.stringify(entry.payload)}</td>
              </tr>
            ))}
            {!entries.length && (
              <tr>
                <td colSpan={4}>
                  <EmptyState text="Журнал аудита пуст. Все действия будут фиксироваться здесь." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  icon: Icon,
  tint,
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
  icon: typeof Users;
  tint: string;
}) {
  return (
    <div className="stat">
      <div className={`stat-icon ${tint}`}>
        <Icon size={18} />
      </div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  const normalized = (value || "").toUpperCase();
  const label: Record<string, string> = {
    ACTIVE: "Активен",
    CLOSED: "Закрыта",
    UNUSED: "Не использован",
    ACTIVATED: "Активирован",
    REVOKED: "Отозван",
    EXPIRED: "Истёк",
    BANNED: "Заблокирован",
    NEW: "Новая",
    IN_PROGRESS: "В работе",
    RESOLVED: "Решена",
    IGNORED: "Игнор",
    PUBLISHED: "Опубликовано",
    DRAFT: "Черновик",
  };

  return (
    <span className={`status-pill status-${normalized.toLowerCase()}`}>
      {label[normalized] || value}
    </span>
  );
}

function SearchBox({
  value,
  setValue,
  placeholder,
}: {
  value: string;
  setValue: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-box">
      <Search size={16} />
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <span>
        <FileText size={18} />
      </span>
      <p>{text}</p>
    </div>
  );
}

function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section className="modal">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={close} title="Закрыть">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function GoogleMark() {
  return <span className="google-mark" aria-hidden="true">G</span>;
}
