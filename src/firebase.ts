import { initializeApp, getApps, getApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  getMultiFactorResolver,
  multiFactor,
  PhoneAuthProvider,
  PhoneMultiFactorGenerator,
  RecaptchaVerifier,
  signInWithPopup,
  signOut,
  type MultiFactorError,
  type PhoneMultiFactorInfo,
  type User,
} from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { getFirestore } from "firebase/firestore";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  child,
  push,
  onValue,
  type Database,
} from "firebase/database";

const RTDB_URL = "https://furry-launcher-default-rtdb.europe-west1.firebasedatabase.app";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCbAfAp4_AydyvWZZ7CyzvLKNM_iTltTYM",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "furry-launcher.firebaseapp.com",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || RTDB_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "furry-launcher",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "furry-launcher.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "1040994944020",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:1040994944020:web:9a916854f2d6bfd0d99301",
};

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb: Database = getDatabase(app, RTDB_URL);
export const functions = getFunctions(app, "europe-west1");
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

// Realtime Database helpers for F Launcher sync
export async function rtdbSet(path: string, data: unknown) {
  try {
    await set(ref(rtdb, path), data);
  } catch (err) {
    console.warn(`RTDB set error at ${path}:`, err);
  }
}

export async function rtdbUpdate(path: string, data: object) {
  try {
    await update(ref(rtdb, path), data);
  } catch (err) {
    console.warn(`RTDB update error at ${path}:`, err);
  }
}

export async function rtdbRemove(path: string) {
  try {
    await remove(ref(rtdb, path));
  } catch (err) {
    console.warn(`RTDB remove error at ${path}:`, err);
  }
}

export async function rtdbGet<T>(path: string): Promise<T | null> {
  try {
    const snapshot = await get(ref(rtdb, path));
    if (snapshot.exists()) {
      return snapshot.val() as T;
    }
    return null;
  } catch (err) {
    console.warn(`RTDB get error at ${path}:`, err);
    return null;
  }
}

export async function call<T>(name: string, data?: Record<string, unknown>): Promise<T> {
  const callable = httpsCallable<Record<string, unknown>, T>(functions, name);
  const result = await callable(data ?? {});
  return result.data;
}

export async function beginGoogleSignIn(): Promise<User | null> {
  try {
    const cred = await signInWithPopup(auth, googleProvider);
    return cred.user;
  } catch (error) {
    const authError = error as MultiFactorError;
    if (authError.code !== "auth/multi-factor-auth-required") {
      throw error;
    }
    const resolver = getMultiFactorResolver(auth, authError);
    const phoneHint = resolver.hints.find(
      (hint) => hint.factorId === PhoneMultiFactorGenerator.FACTOR_ID
    ) as PhoneMultiFactorInfo | undefined;

    if (!phoneHint) {
      throw new Error(
        "У аккаунта нет доступного второго фактора. Добавьте номер телефона в Firebase Authentication."
      );
    }

    const container = document.getElementById("mfa-recaptcha") || document.body;
    const verifier = new RecaptchaVerifier(auth, container, { size: "invisible" });

    try {
      const verificationId = await new PhoneAuthProvider(auth).verifyPhoneNumber(
        { multiFactorHint: phoneHint, session: resolver.session },
        verifier
      );
      const code = window.prompt(
        `Введите код подтверждения из SMS, отправленного на ${phoneHint.phoneNumber || "ваш телефон"}:`
      );
      if (!code) return null;
      const credential = PhoneAuthProvider.credential(verificationId, code.trim());
      const assertion = PhoneMultiFactorGenerator.assertion(credential);
      return (await resolver.resolveSignIn(assertion)).user;
    } finally {
      verifier.clear();
    }
  }
}

export async function enrollPhoneMfa(user: User, verificationId: string, code: string) {
  const credential = PhoneAuthProvider.credential(verificationId, code);
  await multiFactor(user).enroll(
    PhoneMultiFactorGenerator.assertion(credential),
    "CRM security phone"
  );
}

export async function isSecondFactorSession(user: User): Promise<boolean> {
  try {
    const token = await user.getIdTokenResult(true);
    const firebaseClaims = token.claims.firebase as
      | { sign_in_second_factor?: string }
      | undefined;
    return Boolean(firebaseClaims?.sign_in_second_factor);
  } catch {
    return false;
  }
}

export {
  multiFactor,
  signOut,
  RecaptchaVerifier,
  ref as rtdbRef,
  set as rtdbRawSet,
  get as rtdbRawGet,
  update as rtdbRawUpdate,
  remove as rtdbRawRemove,
  onValue as rtdbOnValue,
  push as rtdbPush,
  child as rtdbChild,
};
