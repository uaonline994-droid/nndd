import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertTriangle, Ban, Check, ChevronDown, CircleHelp,
  Clock3, FileText, KeyRound, LayoutDashboard, LogOut, Mail, Menu, Plus, RefreshCw,
  Search, ShieldCheck, ShieldAlert, Users, X,
} from "lucide-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection, doc, getCountFromServer, getDoc, getDocs, limit, orderBy, query,
  where, type QueryConstraint,
} from "firebase/firestore";
import {
  auth, beginGoogleSignIn, call, db, enrollPhoneMfa, isSecondFactorSession, multiFactor,
  RecaptchaVerifier, signOut,
} from "./firebase";

const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL || "a60840397@gmail.com").trim().toLowerCase();

type Role = "owner" | "support" | "marketing";
type Page = "overview" | "zbt" | "players" | "errors" | "news" | "staff" | "analytics" | "audit";
type Campaign = { id: string; name: string; seats: number; status: string; activatedCount: number; createdAt?: number; expiresAt?: number | null };
type Player = { uid: string; nickname: string; contactEmail: string; status: string; zbtCampaignId?: string; lastSeenAt?: number };
type ZbtKey = { id: string; status: string; activatedBy?: string; nickname?: string; installId?: string; activatedAt?: number };
type CrmError = { id: string; fingerprint: string; title: string; area: string; status: string; occurrences: number; affectedPlayers: number; updatedAt?: number; version?: string };
type Announcement = { id: string; title: string; body: string; status: string; updatedAt?: number };
type StaffMember = { id: string; email: string; displayName?: string; role: Role };
type AuditEntry = { id: string; actorUid: string; action: string; payload: Record<string, unknown>; at?: number };
type Overview = { playerCount: number; campaigns: Campaign[]; errors: CrmError[]; daily: Array<{ id: string; date?: string; activePlayers?: number; events?: number }> };

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
