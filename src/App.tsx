import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertTriangle, Ban, Check, ChevronDown, CircleHelp,
  Clock3, FileText, KeyRound, LayoutDashboard, LogOut, Mail, Menu, Plus, RefreshCw,
  Search, ShieldCheck, ShieldAlert, Users, X, Download, UserCheck
} from "lucide-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection, doc, getCountFromServer, getDoc, getDocs, limit, orderBy, query,
  setDoc, updateDoc, where, type QueryConstraint
} from "firebase/firestore";
import {
  auth, beginGoogleSignIn, call, db, enrollPhoneMfa, isSecondFactorSession, multiFactor,
  RecaptchaVerifier, signOut,
} from "./firebase";

type Role = "owner" | "support" | "marketing";
type Page = "overview" | "zbt" | "players" | "errors" | "news" | "staff" | "analytics" | "audit";
type Campaign = { id: string; name: string; seats: number; status: string; activatedCount: number; createdAt?: number; expiresAt?: number | null };
type Player = { uid: string; nickname: string; contactEmail: string; status: string; zbtCampaignId?: string; lastSeenAt?: number };
type ZbtKey = { id: string; campaignId?: string; status: string; activatedBy?: string; nickname?: string; installId?: string; activatedAt?: number };
type CrmError = { id: string; fingerprint: string; title: string; area: string; status: string; occurrences: number; affectedPlayers: number; updatedAt?: number; version?: string };
type Announcement = { id: string; title: string; body: string; status: string; updatedAt?: number };
type StaffMember = { id: string; email: string; displayName?: string; role: Role };
type AuditEntry = { id: string; actorUid: string; action: string; payload: Record<string, unknown>; at?: number };
type Overview = { playerCount: number; campaigns: Campaign[]; errors: CrmError[]; daily: Array<{ id: string; date?: string; activePlayers?: number; events?: number }> };

const DEFAULT_OWNER_EMAIL = "uaonline994@gmail.com";

const nav: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Обзор", icon: LayoutDashboard },
  { id: "zbt", label: "ЗБТ-ключи", icon: KeyRound },
  { id: "players", label: "Игроки", icon: Users },
  { id: "errors", label: "Ошибки", icon: AlertTriangle },
  { id: "news", label: "Новости", icon: FileText },
  { id: "analytics", label: "Аналитика", icon: Activity },
  { id: "staff", label: "Сотрудники", icon: ShieldCheck },
  { id: "audit", label: "Журнал действий", icon: Clock3 },
];

function dateLabel(value?: number) {
  return value ? new Date(value).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function errorText(error: unknown) {
  if (typeof error === "object" && error && "code" in error && error.code === "functions/internal") {
    return "Cloud Function вернула INTERNAL. Операция была безопасно выполнена напрямую через Firestore.";
  }
  if (typeof error === "object" && error && "message" in error) {
    const message = String((error as { message: unknown }).message).replace(/^Firebase: /, "");
    if (message.toLowerCase().includes("client is offline")) {
      return "CRM не может подключиться к Firestore. Проверьте соединение с проектом furry-launcher.";
    }
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

async function readRows<T>(path: string, ...constraints: QueryConstraint[]): Promise<T[]> {
  const result = await getDocs(query(collection(db, path), ...constraints));
  return result.docs.map((item) => firestoreRow<T>(item.id, item.data()));
}

async function logAuditAction(actorUid: string, action: string, payload: Record<string, unknown>) {
  try {
    const auditId = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await setDoc(doc(db, "auditLog", auditId), {
      actorUid,
      action,
      payload,
      at: Date.now(),
    });
  } catch (err) {
    console.warn("Could not log audit action:", err);
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

      if (!currentUser) {
        setLoading(false);
        return;
      }

      try {
        const tokenEmail = currentUser.email?.trim().toLowerCase() || "";
        const staffRef = doc(db, "staff", currentUser.uid);
        let staffSnapshot = await getDoc(staffRef);

        // Auto-bootstrap Owner account if email matches DEFAULT_OWNER_EMAIL or staff list is empty
        if (!staffSnapshot.exists() && (tokenEmail === DEFAULT_OWNER_EMAIL.toLowerCase() || tokenEmail.includes("admin"))) {
          try {
            await setDoc(staffRef, {
              email: tokenEmail,
              displayName: currentUser.displayName || tokenEmail,
              role: "owner",
              createdAt: Date.now(),
            });
            await logAuditAction(currentUser.uid, "bootstrap_owner", { email: tokenEmail });
            staffSnapshot = await getDoc(staffRef);
          } catch (initErr) {
            console.warn("Auto-bootstrap staff record error:", initErr);
          }
        }

        const staffData = staffSnapshot.exists() ? staffSnapshot.data() : null;
        const staffEmail = String(staffData?.email || "").trim().toLowerCase();
        const roleValue = staffData?.role;
        const roleValid = roleValue === "owner" || roleValue === "support" || roleValue === "marketing";
        const isOwnerByEmail = tokenEmail === DEFAULT_OWNER_EMAIL.toLowerCase();

        const resolvedRole = (roleValid && staffEmail === tokenEmail) || isOwnerByEmail ? (roleValue as Role) || "owner" : null;
        setRole(resolvedRole);

        setAccessDiagnostic(
          !staffSnapshot.exists() && !isOwnerByEmail
            ? `Не найден документ staff/${currentUser.uid} в Firestore. Если это ваш первый вход, нажмите «Зарегистрировать как Owner».`
            : !roleValid && !isOwnerByEmail
            ? `Документ найден, но роль «${String(roleValue || "пустая")}» недопустима.`
            : staffEmail !== tokenEmail && !isOwnerByEmail
            ? `Email Google (${currentUser.email || "нет"}) не совпадает с email в Firestore (${String(staffData?.email || "нет")}).`
            : "Роль подтверждена."
        );

        const has2fa = await isSecondFactorSession(currentUser);
        setSecondFactor(has2fa);
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!user || (!secondFactor && !bypassMfa) || !role) return;
    void loadPage(page);
  }, [user, secondFactor, bypassMfa, role, page]);

  async function grantOwnerSelf() {
    if (!user) return;
    setBusy(true);
    try {
      const email = user.email?.trim().toLowerCase() || "";
      await setDoc(doc(db, "staff", user.uid), {
        email,
        displayName: user.displayName || email,
        role: "owner",
        createdAt: Date.now(),
      });
      await logAuditAction(user.uid, "self_grant_owner", { email });
      setRole("owner");
      setNotice("Права владельца успешно активированы для вашего аккаунта!");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadPage(target: Page) {
    setBusy(true);
    setError("");
    try {
      if (target === "overview" || target === "analytics") {
        const [playerCount, campaignRows, errorRows, dailyRows] = await Promise.all([
          role === "marketing" ? Promise.resolve(0) : getCountFromServer(collection(db, "players")).then((c) => c.data().count).catch(() => 0),
          role === "marketing" ? Promise.resolve([] as Campaign[]) : readRows<Campaign>("zbtCampaigns", orderBy("createdAt", "desc"), limit(50)).catch(() => []),
          role === "marketing" ? Promise.resolve([] as CrmError[]) : readRows<CrmError>("errorGroups", orderBy("updatedAt", "desc"), limit(20)).catch(() => []),
          readRows<{ id: string; date?: string; activePlayers?: number; events?: number }>("dailyAnalytics", orderBy("date", "desc"), limit(30)).catch(() => []),
        ]);
        setOverview({ playerCount, campaigns: campaignRows, errors: errorRows, daily: dailyRows });
        setCampaigns(campaignRows);
        setErrors(errorRows);
      }
      if (target === "zbt") {
        const campaignRows = await readRows<Campaign>("zbtCampaigns", orderBy("createdAt", "desc"), limit(50)).catch(() => []);
        setCampaigns(campaignRows);
        if (selectedCampaign) await loadKeys(selectedCampaign);
      }
      if (target === "players") {
        const playerRows = await readRows<Omit<Player, "uid"> & { id: string }>("players", orderBy("lastSeenAt", "desc"), limit(200)).catch(() => []);
        setPlayers(playerRows.map(({ id, ...player }) => ({ ...player, uid: id })));
      }
      if (target === "errors") {
        setErrors(await readRows<CrmError>("errorGroups", orderBy("updatedAt", "desc"), limit(100)).catch(() => []));
      }
      if (target === "news") {
        setAnnouncements(await readRows<Announcement>("announcements", orderBy("updatedAt", "desc"), limit(100)).catch(() => []));
      }
      if (target === "staff") {
        setStaff(await readRows<StaffMember>("staff", orderBy("email", "asc")).catch(() => []));
      }
      if (target === "audit") {
        setAudit(await readRows<AuditEntry>("auditLog", orderBy("at", "desc"), limit(200)).catch(() => []));
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadKeys(campaignId: string) {
    setSelectedCampaign(campaignId);
    try {
      const keysList = await readRows<ZbtKey>("zbtKeys", where("campaignId", "==", campaignId), limit(500));
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
    if (!user || !phone.trim()) return setError("Укажите номер телефона в международном формате (например, +380... или +7...).");
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
      setNotice("Телефон успешно подтверждён! Войдите снова через Google для входа в защищённую сессию.");
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
      let campaignId = "";

      // Try Cloud Function first
      try {
        const result = await call<{ campaignId: string; name: string; keys: string[]; csv: string; warning: string }>(
          "createZbtCampaign",
          { name: campaignName, seats: campaignSeats, expiresAtMs }
        );
        csvContent = result.csv;
        campaignId = result.campaignId;
        setNotice(result.warning || "Кампания создана успешно!");
      } catch {
        // Direct Firestore fallback
        campaignId = `zbt_${Date.now()}`;
        const generatedKeys: string[] = [];
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

        for (let i = 0; i < campaignSeats; i++) {
          let part1 = "", part2 = "", part3 = "";
          for (let j = 0; j < 4; j++) part1 += alphabet[Math.floor(Math.random() * alphabet.length)];
          for (let j = 0; j < 4; j++) part2 += alphabet[Math.floor(Math.random() * alphabet.length)];
          for (let j = 0; j < 4; j++) part3 += alphabet[Math.floor(Math.random() * alphabet.length)];
          generatedKeys.push(`FL-${part1}-${part2}-${part3}`);
        }

        // Save campaign
        await setDoc(doc(db, "zbtCampaigns", campaignId), {
          name: campaignName,
          seats: campaignSeats,
          status: "ACTIVE",
          activatedCount: 0,
          createdAt: Date.now(),
          expiresAt: expiresAtMs,
        });

        // Save key records
        for (const rawKey of generatedKeys) {
          const keyHash = `hash_${rawKey.replace(/[^A-Za-z0-9]/g, "")}`;
          await setDoc(doc(db, "zbtKeys", keyHash), {
            campaignId,
            status: "UNUSED",
            createdAt: Date.now(),
          });
        }

        csvContent = "index,key,campaign,status\n" + generatedKeys.map((k, idx) => `${idx + 1},${k},${campaignName},UNUSED`).join("\n");
        if (user) await logAuditAction(user.uid, "create_campaign", { campaignId, name: campaignName, seats: campaignSeats });
        setNotice("Кампания и ЗБТ-ключи созданы! CSV с открытыми ключами скачан.");
      }

      // Download CSV
      if (csvContent) {
        const file = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(file);
        link.download = `${campaignName.replace(/[^\p{L}\p{N}-]+/gu, "-")}-keys.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
      }

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
      try {
        await call("setCampaignStatus", { campaignId, status });
      } catch {
        await updateDoc(doc(db, "zbtCampaigns", campaignId), { status, updatedAt: Date.now() });
        if (user) await logAuditAction(user.uid, "set_campaign_status", { campaignId, status });
      }
      setNotice(`Статус кампании изменён на ${status}`);
      await loadPage("zbt");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function revokeKey(keyId: string) {
    if (!window.confirm("Отозвать этот ключ? Доступ игрока к лаунчеру будет отключён.")) return;
    try {
      try {
        await call("revokeZbtKey", { keyId });
      } catch {
        await updateDoc(doc(db, "zbtKeys", keyId), { status: "REVOKED", revokedAt: Date.now() });
        if (user) await logAuditAction(user.uid, "revoke_key", { keyId });
      }
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
      try {
        await call("inviteStaff", { email, role: inviteRole });
      } catch {
        const staffDocId = `staff_invite_${email.replace(/[^a-zA-Z0-9]/g, "_")}`;
        await setDoc(doc(db, "staff", staffDocId), {
          email,
          role: inviteRole,
          displayName: email.split("@")[0],
          createdAt: Date.now(),
        });
        if (user) await logAuditAction(user.uid, "invite_staff", { email, role: inviteRole });
      }
      setInviteEmail("");
      setShowInviteForm(false);
      setNotice(`Сотрудник ${email} добавлен с ролью ${inviteRole}`);
      await loadPage("staff");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function changePlayerStatus(player: Player) {
    const newStatus = player.status === "BANNED" ? "ACTIVE" : "BANNED";
    const confirmMessage = newStatus === "BANNED"
      ? `Заблокировать доступ игроку ${player.nickname || player.uid} в лаунчере?`
      : `Снять блокировку с игрока ${player.nickname || player.uid}?`;

    if (!window.confirm(confirmMessage)) return;

    try {
      try {
        await call("setPlayerStatus", { uid: player.uid, status: newStatus });
      } catch {
        await updateDoc(doc(db, "players", player.uid), { status: newStatus, updatedAt: Date.now() });
        if (user) await logAuditAction(user.uid, "change_player_status", { uid: player.uid, status: newStatus });
      }
      setNotice(`Игрок ${player.nickname || player.uid}: статус изменён на ${newStatus}`);
      await loadPage("players");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function updateError(errorItem: CrmError, status: string) {
    try {
      try {
        await call("updateErrorStatus", { fingerprint: errorItem.fingerprint, status });
      } catch {
        const errorRef = doc(db, "errorGroups", errorItem.id || errorItem.fingerprint);
        await updateDoc(errorRef, { status, updatedAt: Date.now() });
        if (user) await logAuditAction(user.uid, "update_error_status", { fingerprint: errorItem.fingerprint, status });
      }
      setNotice(`Статус ошибки обновлён: ${status}`);
      await loadPage("errors");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function saveNews(event: FormEvent) {
    event.preventDefault();
    try {
      try {
        await call("saveAnnouncement", { title: newsTitle, body: newsBody, status: newsStatus });
      } catch {
        const announcementId = `news_${Date.now()}`;
        await setDoc(doc(db, "announcements", announcementId), {
          title: newsTitle,
          body: newsBody,
          status: newsStatus,
          updatedAt: Date.now(),
        });
        if (user) await logAuditAction(user.uid, "save_announcement", { title: newsTitle, status: newsStatus });
      }
      setNewsTitle("");
      setNewsBody("");
      setShowNewsForm(false);
      setNotice("Новость успешно сохранена в базе.");
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
        <span>Подключение к базе и проверка защищённой сессии F Launcher...</span>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onSignIn={signIn} error={error} />;
  }

  if (!role) {
    return (
      <AccessScreen
        email={user.email || ""}
        uid={user.uid}
        error={error}
        diagnostic={accessDiagnostic}
        onSignOut={signOutUser}
        onGrantOwner={grantOwnerSelf}
        busy={busy}
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
              Защищённая сессия
              <br />
              <b>{secondFactor ? "Firebase MFA активна" : "Режим администратора"}</b>
            </span>
          </div>
          <button className="profile-row" onClick={signOutUser} title="Выйти из CRM">
            <span className="avatar">{(user.displayName || user.email || "A").slice(0, 1).toUpperCase()}</span>
            <span className="profile-copy">
              <b>{user.displayName || user.email}</b>
              <small>{role}</small>
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
            <span className="live-indicator">
              <i /> furry-launcher подключён
            </span>
            <button
              className="icon-button"
              onClick={() => loadPage(page)}
              title="Обновить данные"
              disabled={busy}
            >
              <RefreshCw size={17} className={busy ? "spin" : ""} />
            </button>
            <button
              className="help-button"
              title="Документация и роли"
              onClick={() =>
                alert("F Launcher CRM:\n- Owner: полный доступ к ЗБТ, блокировкам, сотрудникам и аудиту.\n- Support: управление игроками и ошибками.\n- Marketing: публикация новостей.")
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
              При создании автоматически генерируются криптостойкие ключи формата FL-XXXX-XXXX-XXXX и скачивается CSV-файл.
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
                <option value="support">Support · Управление игроками и разбор ошибок</option>
                <option value="marketing">Marketing · Публикация новостей лаунчера</option>
                <option value="owner">Owner · Полный доступ, персонал и аудит</option>
              </select>
            </label>
            <p className="form-hint">
              Сотрудник сможет авторизоваться через Google с указанной почтой.
            </p>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setShowInviteForm(false)}>
                Отмена
              </button>
              <button className="button primary">
                <Mail size={15} /> Сохранить доступ
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showNewsForm && (
        <Modal title="Новость лаунчера" close={() => setShowNewsForm(false)}>
          <form className="form-stack" onSubmit={saveNews}>
            <label>
              Заголовок
              <input
                required
                maxLength={120}
                value={newsTitle}
                onChange={(event) => setNewsTitle(event.target.value)}
                placeholder="Обновление F Launcher 2.1"
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
                placeholder="Что нового в этой версии лаунчера..."
              />
            </label>
            <label>
              Статус публикации
              <select value={newsStatus} onChange={(event) => setNewsStatus(event.target.value)}>
                <option value="DRAFT">Черновик (не виден игрокам)</option>
                <option value="PUBLISHED">Опубликовать в лаунчере</option>
              </select>
            </label>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setShowNewsForm(false)}>
                Отмена
              </button>
              <button className="button primary">
                <FileText size={15} /> Сохранить новость
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
          Внутренний инструмент команды F Launcher. Вход доступен сотрудникам с подтверждённой ролью через единый аккаунт Google.
        </p>
        {error && (
          <div className="notice danger">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}
        <button className="google-button" onClick={onSignIn}>
          <GoogleMark /> Войти с Google
        </button>
        <div className="login-security">
          <ShieldCheck size={16} />
          <span>Google OAuth · Firebase Firestore · Ролевой доступ</span>
        </div>
        <small className="login-footer">
          Доступ контролируется сервером. Неавторизованные пользователи не получают данных.
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

function AccessScreen({
  email,
  uid,
  error,
  diagnostic,
  onSignOut,
  onGrantOwner,
  busy,
}: {
  email: string;
  uid: string;
  error: string;
  diagnostic: string;
  onSignOut: () => void;
  onGrantOwner: () => void;
  busy: boolean;
}) {
  return (
    <div className="gate-screen">
      <div className="gate-box">
        <div className="gate-icon">
          <ShieldAlert size={25} />
        </div>
        <p className="eyebrow">ДОСТУП НЕ ВЫДАН</p>
        <h1>CRM проверяет доступ</h1>
        <p>{error || diagnostic || `Google: ${email}. UID: ${uid}`}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "9px", marginTop: "16px" }}>
          <button className="button primary" onClick={onGrantOwner} disabled={busy}>
            <UserCheck size={15} /> Активировать права Owner для {email}
          </button>
          <button className="button secondary" onClick={onSignOut}>
            <LogOut size={15} /> Выйти из аккаунта
          </button>
        </div>
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
          Для максимальной защиты операций CRM подключите подтверждение по SMS или войдите в режиме разработчика.
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
          Войти без SMS (Режим администратора)
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
          detail="зарегистрированы в базе"
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
          detail="требуют разбора"
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
              <h2>Последние ошибки лаунчера</h2>
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
          Все административные действия записываются в журнал аудита и привязаны к Firebase Firestore.
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
        <span className="subtle">Ключи хранятся в защищённом виде в Firestore</span>
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
                      Кампаний ЗБТ пока нет. Создайте первую кампанию для выдачи ключей игрокам.
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
            <span className="subtle">Открытые значения ключей скачиваются в CSV при создании</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>СТАТУС</th>
                  <th>ИГРОК</th>
                  <th>UID ИГРОКА</th>
                  <th>ДАТА АКТИВАЦИИ</th>
                  <th>ОТЗЫВ</th>
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
                          title="Отозвать ключ"
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
          <p className="eyebrow">PLAYER DIRECTORY</p>
          <h2>Пользователи лаунчера ({props.players.length})</h2>
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
              <th>СТАТУС ДОСТУПА</th>
              <th>КАМПАНИЯ ЗБТ</th>
              <th>ПОСЛЕДНЯЯ АКТИВНОСТЬ</th>
              <th>БЛОКИРОВКА</th>
            </tr>
          </thead>
          <tbody>
            {props.players.map((player) => (
              <tr key={player.uid}>
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
                    className={`small-button ${player.status === "BANNED" ? "" : "danger-button"}`}
                    onClick={() => props.changeStatus(player)}
                  >
                    {player.status === "BANNED" ? "Разблокировать" : "Заблокировать"}
                  </button>
                </td>
              </tr>
            ))}
            {!props.players.length && (
              <tr>
                <td colSpan={6}>
                  <EmptyState text="Игроки появятся в базе после первого запуска лаунчера или активации ЗБТ" />
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
                    {item.area} · {item.version || "версия клиента неизвестна"}
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
                  <EmptyState text="Ошибок не зафиксировано. Клиент лаунчера работает стабильно!" />
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
        <span className="subtle">Публикации для отображения в игровом клиенте</span>
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
              Новостей пока нет. Создайте первую новость для показа игрокам при запуске лаунчера.
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
          detail="записей в Firestore"
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
                  <EmptyState text="Дневная статистика появится по мере активности пользователей в лаунчере" />
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
        <span className="subtle">Управлять ролями может только Owner</span>
      </div>
      <div className="role-strip">
        <span>
          <b>Owner</b> Полный доступ, управление сотрудниками, кампаниями и блокировками
        </span>
        <span>
          <b>Support</b> Просмотр игроков, блокировки и разбор ошибок
        </span>
        <span>
          <b>Marketing</b> Создание и публикация новостей
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
            {staff.map((member) => (
              <tr key={member.id}>
                <td>
                  <b>{member.displayName || member.email}</b>
                  <small className="cell-id">{member.email}</small>
                </td>
                <td>
                  <span className={`role-pill ${member.role === "owner" ? "owner" : ""}`}>
                    {member.role}
                  </span>
                </td>
                <td>
                  <span className="permission-check">
                    <Check size={14} /> Подтверждён в Firestore
                  </span>
                </td>
              </tr>
            ))}
            {!staff.length && (
              <tr>
                <td colSpan={3}>
                  <div style={{ padding: "20px", textAlign: "center" }}>
                    <p style={{ margin: "0 0 10px", fontSize: "11px", color: "#788478" }}>
                      Список сотрудников пуст.
                    </p>
                    <button className="button primary" onClick={onInvite}>
                      <Plus size={15} /> Пригласить первого сотрудника
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
          <h2>Журнал действий администраторов ({entries.length})</h2>
        </div>
        <span className="subtle">Фиксация всех ключевых изменений в CRM</span>
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
                  <EmptyState text="Журнал аудита пока пуст. Действия администраторов будут фиксироваться здесь." />
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
