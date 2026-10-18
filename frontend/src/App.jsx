import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import logoUrl from "../logo.svg";
import { API_ORIGIN, api, isTokenExpired, onUnauthorized, setAccessToken } from "./api";
import ModeratorMessage from "./ModeratorMessage";

const courtVisuals = [
  "linear-gradient(135deg, rgba(199,226,29,.95), rgba(245,245,243,.7)), radial-gradient(circle at 20% 20%, #111 0 2px, transparent 3px)",
  "linear-gradient(135deg, rgba(17,17,17,.94), rgba(42,42,42,.76)), repeating-linear-gradient(90deg, transparent 0 22px, rgba(199,226,29,.42) 23px 24px)",
  "linear-gradient(135deg, rgba(236,236,232,.98), rgba(199,226,29,.46)), linear-gradient(45deg, transparent 48%, #111 49% 51%, transparent 52%)"
];

const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const managerRoles = new Set(["moderator", "admin", "superuser"]);
const defaultRoleNames = ["user", "moderator", "admin", "superuser"];
const permissionEditableRoles = new Set(["user", "moderator", "admin"]);
const ACCESS_TOKEN_STORAGE_KEY = "courtly_access_token";
const defaultMapCenter = [49.8397, 24.0297];
const defaultMarkerIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

const endpointPermissionCatalog = [
  { endpoint: "/auth/login", methods: ["create"] },
  { endpoint: "/auth/register", methods: ["create"] },
  { endpoint: "/courts", methods: ["read", "create"] },
  { endpoint: "/courts/:courtId", methods: ["read", "update", "delete"] },
  { endpoint: "/courts/:courtId/availability", methods: ["read"] },
  { endpoint: "/bookings/hold", methods: ["create"] },
  { endpoint: "/bookings/confirm", methods: ["create"] },
  { endpoint: "/bookings/:bookingId/cancel", methods: ["create"] },
  { endpoint: "/me/bookings", methods: ["read"] },
  { endpoint: "/me/bookings/:bookingId", methods: ["read"] },
  { endpoint: "/me/profile", methods: ["read", "update"] },
  { endpoint: "/me/profile/request-data-deletion", methods: ["create"] },
  { endpoint: "/me/favorites", methods: ["read", "create"] },
  { endpoint: "/me/favorites/:courtId", methods: ["delete"] },
  { endpoint: "/me/reviews", methods: ["create"] },
  { endpoint: "/me/reviews/public/:courtId", methods: ["read"] },
  { endpoint: "/me/moderator-message", methods: ["create"] },
  { endpoint: "/admin/users", methods: ["read", "create"] },
  { endpoint: "/admin/users/:userId", methods: ["update", "delete"] },
  { endpoint: "/admin/roles", methods: ["read", "create"] },
  { endpoint: "/admin/roles/:roleId", methods: ["delete"] },
  { endpoint: "/admin/policies", methods: ["read", "create"] },
  { endpoint: "/admin/policies/:policyId", methods: ["update", "delete"] },
  { endpoint: "/admin/bookings", methods: ["read"] },
  { endpoint: "/admin/event-log/replay", methods: ["create"] },
  { endpoint: "/dashboard/notifications/email", methods: ["create"] },
  { endpoint: "/dashboard/bookings", methods: ["read"] },
  { endpoint: "/dashboard/bookings/:bookingId/remind", methods: ["create"] }
];

function formatMoney(value) {
  return `${value} UAH`;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfWeek(date) {
  const copy = new Date(date);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function addMinutes(date, minutes) {
  const copy = new Date(date);
  copy.setMinutes(copy.getMinutes() + minutes);
  return copy;
}

function displayTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function displayDate(value) {
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
}

function displayLongDate(value) {
  return new Date(value).toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric" });
}

function formatBookingRange(startsAt, endsAt) {
  return `${displayLongDate(startsAt)} · ${displayTime(startsAt)} – ${displayTime(endsAt)}`;
}

function bookingDurationMinutes(startsAt, endsAt) {
  const diff = new Date(endsAt).getTime() - new Date(startsAt).getTime();
  return Math.max(0, Math.round(diff / 60000));
}

function passwordPolicyStatus(value) {
  return {
    minLength: value.length >= 8,
    hasUpper: /[A-Z]/.test(value),
    hasLower: /[a-z]/.test(value),
    hasDigit: /\d/.test(value),
    hasSpecial: /[^A-Za-z0-9]/.test(value)
  };
}

function estimatePasswordEntropy(value) {
  if (!value) {
    return 0;
  }
  let pool = 0;
  if (/[a-z]/.test(value)) {
    pool += 26;
  }
  if (/[A-Z]/.test(value)) {
    pool += 26;
  }
  if (/\d/.test(value)) {
    pool += 10;
  }
  if (/[^A-Za-z0-9]/.test(value)) {
    pool += 32;
  }
  if (pool === 0) {
    return 0;
  }
  return Math.log2(pool) * value.length;
}

function getPasswordStrength(value) {
  const policy = passwordPolicyStatus(value);
  const isCompliant = Object.values(policy).every(Boolean);
  if (!isCompliant) {
    return "low";
  }
  const entropy = estimatePasswordEntropy(value);
  if (value.length < 12 || entropy < 60) {
    return "mid";
  }
  return "secure";
}

function bookingStatusInfo(booking) {
  if (!booking) {
    return { label: "—", tone: "neutral", group: "past" };
  }
  const status = booking.status;
  const startsAt = new Date(booking.starts_at).getTime();
  const isFuture = startsAt > Date.now();
  if (status === "cancelled") {
    return { label: "Скасовано", tone: "danger", group: "cancelled" };
  }
  if (status === "completed") {
    return { label: "Завершено", tone: "muted", group: "past" };
  }
  if (status === "draft_hold") {
    return { label: "Тримається", tone: "warning", group: isFuture ? "upcoming" : "past" };
  }
  if (status === "confirmed" || status === "active") {
    return {
      label: isFuture ? "Підтверджено" : "Завершено",
      tone: isFuture ? "success" : "muted",
      group: isFuture ? "upcoming" : "past"
    };
  }
  return { label: status || "—", tone: "neutral", group: isFuture ? "upcoming" : "past" };
}

function isBookingCancellable(booking) {
  if (!booking) {
    return false;
  }
  if (booking.status === "cancelled" || booking.status === "completed") {
    return false;
  }
  return new Date(booking.starts_at).getTime() > Date.now();
}

function getInitials(fullName) {
  if (!fullName) {
    return "?";
  }
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  const letters = parts.slice(0, 2).map((part) => part[0].toUpperCase());
  return letters.join("");
}

function secondsUntil(deadlineIso, nowMs) {
  if (!deadlineIso) {
    return 0;
  }
  const deadlineMs = new Date(deadlineIso).getTime();
  return Math.floor((deadlineMs - nowMs) / 1000);
}

function formatCountdown(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const days = Math.floor(safe / 86400);
  const hours = Math.floor((safe % 86400) / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (days > 0) {
    return `${days} дн. ${hours} год.`;
  }
  if (hours > 0) {
    return `${hours} год. ${minutes} хв.`;
  }
  return `${minutes} хв.`;
}

function deletionUrgencyTone(seconds) {
  if (seconds <= 0) {
    return "danger";
  }
  const days = seconds / 86400;
  if (days <= 3) {
    return "danger";
  }
  if (days <= 7) {
    return "warning";
  }
  return "success";
}

function sameSlot(a, b) {
  return new Date(a).getTime() === new Date(b).getTime();
}

function isContiguous(slots) {
  if (slots.length < 2) {
    return false;
  }
  for (let index = 1; index < slots.length; index += 1) {
    const previous = new Date(slots[index - 1].starts_at).getTime();
    const current = new Date(slots[index].starts_at).getTime();
    if (current - previous !== 30 * 60 * 1000) {
      return false;
    }
  }
  return true;
}

function permissionKey(endpoint, method) {
  return `${endpoint}::${method}`;
}

function parseOwnershipCondition(policy) {
  const raw = (policy?.condition || "").toString().trim().toLowerCase();
  if (raw.includes("self")) {
    return "self";
  }
  if (raw.includes("all")) {
    return "all";
  }
  return "all";
}

function normalizePolicyFields(policy) {
  return {
    id: policy.id,
    role: policy.role || policy.role_name || policy.subject || "",
    endpoint: policy.endpoint || policy.resource || "",
    method: (policy.method || policy.action || "").toLowerCase(),
    effect: (policy.effect || "allow").toLowerCase(),
    ownership: parseOwnershipCondition(policy)
  };
}

function buildPermissionDraftMap(roleNames, policyList) {
  const normalized = policyList.map(normalizePolicyFields);
  const byRole = {};

  for (const roleName of roleNames) {
    byRole[roleName] = {};
    for (const entry of endpointPermissionCatalog) {
      for (const method of entry.methods) {
        const key = permissionKey(entry.endpoint, method);
        const existing = normalized.find(
          (policy) => policy.role === roleName && policy.endpoint === entry.endpoint && policy.method === method
        );
        byRole[roleName][key] = {
          endpoint: entry.endpoint,
          method,
          allowed: Boolean(existing && existing.effect === "allow"),
          ownership: existing?.ownership || "all",
          policyId: existing?.id || null
        };
      }
    }
  }

  return byRole;
}

function Logo() {
  return (
    <button className="logo" aria-label="Courtly home" type="button">
      <img src={logoUrl} alt="Courtly" />
    </button>
  );
}

function toNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function makePoint(court, index) {
  const lat = toNumber(court.latitude);
  const lng = toNumber(court.longitude);
  if (lat !== null && lng !== null) {
    return { ...court, mapLat: lat, mapLng: lng };
  }
  const offset = (index % 7) * 0.006;
  return {
    ...court,
    mapLat: defaultMapCenter[0] + offset,
    mapLng: defaultMapCenter[1] + offset / 2
  };
}

function FlyToActiveCourt({ activeCourt }) {
  const map = useMap();
  useEffect(() => {
    if (!activeCourt) {
      return;
    }
    const lat = toNumber(activeCourt.latitude);
    const lng = toNumber(activeCourt.longitude);
    if (lat !== null && lng !== null) {
      map.flyTo([lat, lng], Math.max(map.getZoom(), 13), { duration: 0.5 });
    }
  }, [activeCourt, map]);
  return null;
}

function CourtsMap({ activeCourt, courts, onSelectCourt }) {
  const points = useMemo(() => courts.map((court, index) => makePoint(court, index)), [courts]);

  return (
    <div className="map-canvas">
      <MapContainer center={defaultMapCenter} zoom={13} scrollWheelZoom className="map-embed">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {points.map((court) => (
          <Marker
            key={court.id}
            position={[court.mapLat, court.mapLng]}
            icon={defaultMarkerIcon}
            eventHandlers={{
              click: () => onSelectCourt(court.id)
            }}
          >
            <Popup>
              <strong>{court.name}</strong>
              <br />
              {court.address}
              <br />
              {formatMoney(court.price_per_hour)} / h
            </Popup>
          </Marker>
        ))}
        <FlyToActiveCourt activeCourt={activeCourt} />
      </MapContainer>
      {activeCourt ? (
        <div className="map-card">
          <span>Обраний корт</span>
          <strong>{activeCourt.name}</strong>
          <small>{activeCourt.address}</small>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const filterChipOptions = ["Поруч зі мною", "Indoor", "Open now", "4.5+ rating"];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaChallengeToken, setMfaChallengeToken] = useState("");
  const [mfaDevCode, setMfaDevCode] = useState("");
  const [emailVerificationCode, setEmailVerificationCode] = useState("");
  const [emailVerificationChallengeToken, setEmailVerificationChallengeToken] = useState("");
  const [emailVerificationDevCode, setEmailVerificationDevCode] = useState("");
  const [authMode, setAuthMode] = useState("signin");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [token, setToken] = useState(() => {
    const stored = localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || "";
    if (stored && isTokenExpired(stored)) {
      localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
      return "";
    }
    return stored;
  });
  const [view, setView] = useState("home");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [city, setCity] = useState("Kyiv");
  const [district, setDistrict] = useState("All districts");
  const [activeCourtFilters, setActiveCourtFilters] = useState(["Поруч зі мною"]);
  const [weekStart, setWeekStart] = useState(startOfWeek(new Date()));
  const [courts, setCourts] = useState([]);
  const [activeCourtId, setActiveCourtId] = useState("");
  const [availability, setAvailability] = useState([]);
  const [courtBookings, setCourtBookings] = useState([]);
  const [courtReviews, setCourtReviews] = useState([]);
  const [selectedSlots, setSelectedSlots] = useState([]);
  const [checkoutHold, setCheckoutHold] = useState(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const checkoutInFlight = useRef(false);
  const [completedCheckout, setCompletedCheckout] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [myReviews, setMyReviews] = useState([]);
  const [cabinetTab, setCabinetTab] = useState("bookings");
  const [bookingStatusFilter, setBookingStatusFilter] = useState("upcoming");
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState("");
  const [moderatorMessage, setModeratorMessage] = useState("");
  const [profile, setProfile] = useState(null);
  const [profileDraft, setProfileDraft] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [adminUsers, setAdminUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [permissionDrafts, setPermissionDrafts] = useState({});
  const [expandedEndpoint, setExpandedEndpoint] = useState(endpointPermissionCatalog[0]?.endpoint || "");
  const [expandedMethodKey, setExpandedMethodKey] = useState("");
  const [adminBookings, setAdminBookings] = useState([]);
  const [moderatorMessages, setModeratorMessages] = useState([]);
  const [bookingRemindComments, setBookingRemindComments] = useState({});
  const [dataDeletionRequests, setDataDeletionRequests] = useState([]);
  const [dataDeletionFilter, setDataDeletionFilter] = useState("pending");
  const [myDataDeletionRequest, setMyDataDeletionRequest] = useState(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [selectedAdminUserId, setSelectedAdminUserId] = useState(null);
  const [adminUserForm, setAdminUserForm] = useState(null);
  const [selectedAdminCourtId, setSelectedAdminCourtId] = useState("");
  const [adminCourtForm, setAdminCourtForm] = useState(null);
  const [adminTab, setAdminTab] = useState("users");
  const [dragStartSlot, setDragStartSlot] = useState(null);
  const [isDraggingSlots, setIsDraggingSlots] = useState(false);
  const [newUser, setNewUser] = useState({
    email: "",
    full_name: "",
    password: "ChangeMeNow123!",
    role: "user"
  });
  const [newRole, setNewRole] = useState("");
  const [newCourt, setNewCourt] = useState({
    name: "",
    city: "Kyiv",
    district: "Pechersk",
    address: "",
    surface: "Hard",
    price_per_hour: 700,
    opening_time: "07:00",
    closing_time: "22:00",
    image_url: ""
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [log, setLog] = useState([]);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const profileMenuRef = useRef(null);
  const confirmResolverRef = useRef(null);
  const signupPasswordPolicy = useMemo(() => passwordPolicyStatus(password), [password]);
  const isSignupPasswordCompliant = useMemo(() => Object.values(signupPasswordPolicy).every(Boolean), [signupPasswordPolicy]);
  const signupPasswordStrength = useMemo(() => getPasswordStrength(password), [password]);

  const addLog = (title, payload) => {
    setLog((current) => [{ title, payload }, ...current].slice(0, 10));
  };

  function askForConfirmation(message, options = {}) {
    if (confirmResolverRef.current) {
      confirmResolverRef.current(false);
    }

    setConfirmDialog({
      title: options.title || "Підтвердження",
      message,
      confirmLabel: options.confirmLabel || "Підтвердити",
      cancelLabel: options.cancelLabel || "Скасувати",
      tone: options.tone || "warning"
    });

    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
    });
  }

  function closeConfirmDialog(confirmed) {
    setConfirmDialog(null);
    if (confirmResolverRef.current) {
      confirmResolverRef.current(confirmed);
      confirmResolverRef.current = null;
    }
  }

  const isAuthed = token.length > 0;
  const isManager = profile ? managerRoles.has(profile.role) : false;
  const allRoleNames = useMemo(() => {
    const loaded = roles.map((role) => role.name).filter(Boolean);
    return [...new Set([...defaultRoleNames, ...loaded])].filter((roleName) => permissionEditableRoles.has(roleName));
  }, [roles]);
  const activeCourt = useMemo(() => courts.find((court) => court.id === activeCourtId) || courts[0] || null, [activeCourtId, courts]);
  const filteredCourts = useMemo(() => {
    return courts.filter((court) => {
      const cityMatch = city === "All cities" || court.city === city;
      const districtMatch = district === "All districts" || court.district === district;
      if (!cityMatch || !districtMatch) {
        return false;
      }

      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const openingMinutes = court.opening_time
        ? Number(court.opening_time.split(":")[0]) * 60 + Number(court.opening_time.split(":")[1])
        : 0;
      const closingMinutes = court.closing_time
        ? Number(court.closing_time.split(":")[0]) * 60 + Number(court.closing_time.split(":")[1])
        : 24 * 60;
      const distanceKm = Number.parseFloat((court.distance || "").toString().replace(" km", ""));
      const rating = Number(court.rating || 0);

      if (activeCourtFilters.includes("Поруч зі мною") && Number.isFinite(distanceKm) && distanceKm > 2.5) {
        return false;
      }
      if (activeCourtFilters.includes("Indoor") && court.surface?.toLowerCase() === "grass") {
        return false;
      }
      if (activeCourtFilters.includes("Open now") && !(nowMinutes >= openingMinutes && nowMinutes < closingMinutes)) {
        return false;
      }
      if (activeCourtFilters.includes("4.5+ rating") && rating < 4.5) {
        return false;
      }

      return true;
    });
  }, [activeCourtFilters, city, courts, district]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const weekSlots = useMemo(() => {
    const grouped = new Map();
    for (const slot of availability) {
      const key = dateKey(new Date(slot.starts_at));
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push(slot);
    }
    return grouped;
  }, [availability]);
  const selectedDuration = selectedSlots.length * 30;
  const selectedTotal = Math.round((activeCourt?.price_per_hour || 0) * (selectedDuration / 60));
  const canConfirmSelection = isContiguous(selectedSlots);
  const slotHint = canConfirmSelection ? "Можна підтверджувати." : "Обери два або більше суміжні слоти.";
  const bookingGroups = useMemo(() => {
    const groups = { upcoming: [], past: [], cancelled: [] };
    for (const booking of bookings) {
      const info = bookingStatusInfo(booking);
      if (groups[info.group]) {
        groups[info.group].push(booking);
      }
    }
    return groups;
  }, [bookings]);
  const visibleBookings = useMemo(() => {
    if (bookingStatusFilter === "all") {
      return bookings;
    }
    return bookingGroups[bookingStatusFilter] || [];
  }, [bookings, bookingGroups, bookingStatusFilter]);
  const totalSpent = useMemo(
    () =>
      bookings
        .filter((booking) => booking.status !== "cancelled" && booking.status !== "draft_hold")
        .reduce((sum, booking) => sum + (Number(booking.total_price) || 0), 0),
    [bookings]
  );
  const isEditingProfile = profileDraft !== null;

  useEffect(() => {
    loadCourts();
  }, []);

  useEffect(() => {
    if (!token) {
      setAccessToken("");
      localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
      setMyDataDeletionRequest(null);
      return;
    }

    setAccessToken(token);
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
    loadCabinet(true);
    loadMyDataDeletionStatus();
  }, [token]);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!error) {
      return undefined;
    }
    const id = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(id);
  }, [error]);

  useEffect(() => {
    if (!success) {
      return undefined;
    }
    const id = setTimeout(() => setSuccess(""), 4000);
    return () => clearTimeout(id);
  }, [success]);

  useEffect(() => {
    onUnauthorized((reason) => {
      if (!localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)) {
        return;
      }
      localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
      setAccessToken("");
      setToken("");
      setCheckoutHold(null);
      setCompletedCheckout(null);
      setProfile(null);
      setProfileDraft(null);
      setBookings([]);
      setMyReviews([]);
      setFavorites([]);
      setSelectedBooking(null);
      setMyDataDeletionRequest(null);
      setAdminUsers([]);
      setRoles([]);
      setPolicies([]);
      setAdminBookings([]);
      setDataDeletionRequests([]);
      setView("cabinet");
      setSuccess("");
      setError(
        reason === "expired"
          ? "Сесія завершилась — увійди заново."
          : "Сесію відхилено сервером — увійди заново."
      );
    });
    return () => onUnauthorized(null);
  }, []);

  useEffect(() => {
    if (view === "admin" && isAuthed && isManager) {
      loadDataDeletionRequests(dataDeletionFilter);
    }
  }, [dataDeletionFilter, view, isAuthed, isManager]);

  useEffect(() => {
    if (activeCourtId) {
      loadAvailability(activeCourtId, weekStart);
    }
  }, [activeCourtId, weekStart]);

  useEffect(() => {
    if (view === "admin" && isAuthed && isManager) {
      loadAdmin();
    }
  }, [view, isAuthed, isManager]);

  useEffect(() => {
    if (profile?.role === "moderator" && !["bookings", "moderator-messages"].includes(adminTab)) {
      setAdminTab("bookings");
    }
  }, [profile, adminTab]);

  useEffect(() => {
    if (view === "detail" && activeCourtId) {
      loadCourtInsights(activeCourtId);
    }
  }, [view, activeCourtId]);

  useEffect(() => {
    if (!isProfileMenuOpen) {
      return undefined;
    }

    function handleProfileMenuOutsideClick(event) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target)) {
        setIsProfileMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleProfileMenuOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleProfileMenuOutsideClick);
    };
  }, [isProfileMenuOpen]);

  useEffect(() => {
    if (!confirmDialog) {
      return undefined;
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        closeConfirmDialog(false);
      }
    }

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [confirmDialog]);

  async function handleLogin(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    try {
      const data = await api.login({ email, password });
      if (data.email_verification_required) {
        setEmailVerificationChallengeToken(data.email_verification_challenge_token || "");
        setEmailVerificationDevCode(data.email_verification_dev_code || "");
        setEmailVerificationCode("");
        setMfaChallengeToken("");
        setSuccess("Ми відправили код підтвердження на вашу пошту.");
        return;
      }
      if (data.mfa_required) {
        setMfaChallengeToken(data.mfa_challenge_token || "");
        setMfaDevCode(data.mfa_dev_code || "");
        setMfaCode("");
        setEmailVerificationChallengeToken("");
        setSuccess("На вашу пошту відправлено 6-значний код.");
        return;
      }
      setToken(data.access_token);
      addLog("Login", data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleVerifyMfa(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!mfaChallengeToken) {
      setError("MFA challenge не знайдено. Спробуйте увійти ще раз.");
      return;
    }
    try {
      const data = await api.verify2fa({ challenge_token: mfaChallengeToken, code: mfaCode.trim() });
      setToken(data.access_token);
      setMfaChallengeToken("");
      setMfaCode("");
      setMfaDevCode("");
      addLog("MFA verified", data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleVerifyEmail(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!emailVerificationChallengeToken) {
      setError("Email verification challenge не знайдено. Спробуйте увійти або зареєструватись ще раз.");
      return;
    }
    try {
      const data = await api.verifyEmail({
        challenge_token: emailVerificationChallengeToken,
        code: emailVerificationCode.trim()
      });
      setToken(data.access_token);
      setEmailVerificationChallengeToken("");
      setEmailVerificationCode("");
      setEmailVerificationDevCode("");
      setSuccess("Email підтверджено.");
      addLog("Email verified", data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (password !== confirmPassword) {
      setError("Паролі не співпадають.");
      return;
    }
    if (!acceptedTerms) {
      setError("Потрібно погодитись з Privacy Policy та Terms of Service.");
      return;
    }
    if (!isSignupPasswordCompliant) {
      setError("Пароль не відповідає вимогам безпеки.");
      return;
    }
    try {
      const data = await api.register({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email,
        password
      });
      if (data.email_verification_required) {
        setAuthMode("signin");
        setEmailVerificationChallengeToken(data.email_verification_challenge_token || "");
        setEmailVerificationDevCode(data.email_verification_dev_code || "");
        setEmailVerificationCode("");
        setSuccess("Акаунт створено. Підтвердіть email кодом із листа.");
        return;
      }
      setToken(data.access_token);
      setSuccess("Акаунт створено.");
      setView("home");
    } catch (err) {
      setError(err.message);
    }
  }

  async function logout() {
    const confirmed = await askForConfirmation("Ви дійсно хочете вийти з акаунту?", {
      title: "Вийти з акаунту",
      confirmLabel: "Вийти",
      tone: "danger"
    });
    if (!confirmed) {
      return;
    }
    setToken("");
    setCheckoutHold(null);
    setCompletedCheckout(null);
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    setProfile(null);
    setProfileDraft(null);
    setBookings([]);
    setMyReviews([]);
    setFavorites([]);
    setSelectedBooking(null);
    setAdminUsers([]);
    setRoles([]);
    setPolicies([]);
    setAdminBookings([]);
    setView("home");
  }

  async function loadCourts() {
    setError("");
    try {
      const data = await api.listCourts();
      const normalized = data.map((court, index) => ({
        ...court,
        rating: Number(court.rating_avg || 0),
        distance: `${(1.1 + index * 0.7).toFixed(1)} km`,
        nextSlot: index % 2 === 0 ? "18:00" : "19:30",
        image: courtVisuals[index % courtVisuals.length],
        tags: [court.surface, "Verified", "Fast booking"]
      }));
      setCourts(normalized);
      if (normalized.length > 0) {
        setActiveCourtId(normalized[0].id);
        if (!selectedAdminCourtId) {
          setSelectedAdminCourtId(normalized[0].id);
          setAdminCourtForm(normalized[0]);
        }
      }
      addLog("Loaded courts", data);
    } catch (err) {
      setError(`Courts API unavailable: ${err.message}`);
    }
  }

  async function loadAvailability(courtId, start) {
    try {
      const data = await api.getAvailability(courtId, start.toISOString());
      const scoped = data.filter((slot) => {
        const hour = new Date(slot.starts_at).getHours();
        return hour >= 5 && hour <= 23;
      });
      setAvailability(scoped);
      setSelectedSlots([]);
    } catch (err) {
      setAvailability([]);
      setError(`Availability API unavailable: ${err.message}`);
    }
  }

  async function loadCabinet(force = false) {
    if (!force && !isAuthed && !token) {
      return;
    }
    setError("");
    try {
      const [b, p, f, r] = await Promise.all([
        api.listMyBookings(),
        api.getProfile(),
        api.listFavorites(),
        api.listMyReviews()
      ]);
      setBookings(b);
      setProfile(p);
      setFavorites((current) => [...new Set([...current, ...f.map((item) => item.court_id)])]);
      setMyReviews(r);
      addLog("Loaded cabinet", { bookings: b, profile: p, favorites: f, reviews: r });
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadBookingDetail(bookingId) {
    try {
      const detail = await api.getMyBooking(bookingId);
      setSelectedBooking(detail);
      if (detail.my_review) {
        setReviewRating(detail.my_review.rating);
        setReviewComment(detail.my_review.comment || "");
      } else {
        setReviewRating(5);
        setReviewComment("");
      }
      setModeratorMessage("");
    } catch (err) {
      setError(err.message);
    }
  }

  function closeBookingDetail() {
    setSelectedBooking(null);
    setReviewComment("");
    setReviewRating(5);
    setModeratorMessage("");
  }

  function startEditProfile() {
    setProfileDraft({
      full_name: profile?.full_name || "",
      phone: profile?.phone || ""
    });
  }

  function cancelEditProfile() {
    setProfileDraft(null);
  }

  async function saveProfileEdits(event) {
    event.preventDefault();
    if (!profileDraft) {
      return;
    }
    setError("");
    try {
      const payload = {};
      const draftName = profileDraft.full_name?.trim();
      const draftPhone = profileDraft.phone?.trim();
      if (draftName && draftName !== profile?.full_name) {
        payload.full_name = draftName;
      }
      if (draftPhone !== (profile?.phone || "")) {
        payload.phone = draftPhone || null;
      }
      const updated = Object.keys(payload).length > 0 ? await api.updateProfile(payload) : profile;
      setProfile(updated);
      setProfileDraft(null);
      setSuccess("Профіль оновлено.");
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleMfaPreference() {
    if (!profile) {
      return;
    }
    setError("");
    setSuccess("");
    try {
      const updated = await api.updateMfaPreference({ enabled: !profile.mfa_enabled });
      setProfile(updated);
      setSuccess(updated.mfa_enabled ? "MFA увімкнено." : "MFA вимкнено.");
    } catch (err) {
      setError(err.message);
    }
  }

  async function cancelMyBooking(bookingId) {
    const confirmed = await askForConfirmation("Бронювання буде скасовано. Цю дію не можна скасувати.", {
      title: "Скасувати бронювання?",
      confirmLabel: "Скасувати бронь",
      cancelLabel: "Не скасовувати",
      tone: "danger"
    });
    if (!confirmed) {
      return;
    }
    try {
      await api.cancelBooking(bookingId, { reason: "User initiated cancellation" });
      setSuccess("Бронювання скасовано.");
      await loadCabinet();
      if (selectedBooking?.id === bookingId) {
        await loadBookingDetail(bookingId);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadMyDataDeletionStatus() {
    try {
      const data = await api.getDataDeletionStatus();
      setMyDataDeletionRequest(data);
    } catch (err) {
      setMyDataDeletionRequest(null);
    }
  }

  async function requestDataDeletion() {
    const confirmed = await askForConfirmation(
      "Запит на видалення персональних даних буде надіслано адміністраторам. Згідно GDPR ми маємо 14 днів, щоб його обробити. Якщо ніхто не відреагує — акаунт автоматично видалиться.",
      {
        title: "Видалити дані?",
        confirmLabel: "Надіслати запит",
        cancelLabel: "Скасувати",
        tone: "danger"
      }
    );
    if (!confirmed) {
      return;
    }
    try {
      const result = await api.requestDataDeletion({});
      setMyDataDeletionRequest(result);
      setSuccess("Запит надіслано. Адміністратори мають 14 днів, щоб його обробити.");
    } catch (err) {
      setError(err.message);
    }
  }

  async function withdrawDataDeletion() {
    const confirmed = await askForConfirmation("Запит на видалення буде відкликано. Ви можете створити новий пізніше.", {
      title: "Відкликати запит?",
      confirmLabel: "Відкликати",
      cancelLabel: "Залишити"
    });
    if (!confirmed) {
      return;
    }
    try {
      await api.cancelDataDeletionRequest();
      setMyDataDeletionRequest(null);
      setSuccess("Запит відкликано.");
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitCourtReview(event) {
    event.preventDefault();
    if (!selectedBooking) {
      setError("Спочатку відкрий конкретне бронювання в кабінеті.");
      return;
    }
    try {
      await api.createReview({
        booking_id: selectedBooking.id,
        court_id: selectedBooking.court_id,
        rating: Number(reviewRating),
        comment: reviewComment
      });
      setReviewComment("");
      setSuccess("Відгук додано.");
      await loadBookingDetail(selectedBooking.id);
      await loadCourts();
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadCourtInsights(courtId) {
    try {
      const [bookingsData, reviewsData] = await Promise.all([api.listCourtBookings(courtId), api.listPublicReviews(courtId)]);
      setCourtBookings(bookingsData);
      setCourtReviews(reviewsData);
    } catch (err) {
      setCourtBookings([]);
      setCourtReviews([]);
      setError(err.message);
    }
  }

  async function sendModeratorMessage(event) {
    event.preventDefault();
    try {
      await api.messageModerator({
        booking_id: selectedBooking?.id || null,
        court_id: selectedBooking?.court_id || activeCourt?.id || null,
        subject: selectedBooking ? `Booking ${selectedBooking.id}` : "Court question",
        message: moderatorMessage
      });
      setModeratorMessage("");
      setSuccess("Повідомлення модератору відправлено.");
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleSlot(slot) {
    if (slot.state !== "free") {
      return;
    }
    setSelectedSlots((current) => {
      const exists = current.some((item) => sameSlot(item.starts_at, slot.starts_at));
      if (exists) {
        return current.filter((item) => !sameSlot(item.starts_at, slot.starts_at));
      }
      const next = [...current, slot].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
      if (next.length > 4) {
        return [slot];
      }
      return next;
    });
  }

  function selectSlotRange(startSlot, endSlot) {
    if (!startSlot || !endSlot || startSlot.state !== "free" || endSlot.state !== "free") {
      return;
    }
    const startMs = new Date(startSlot.starts_at).getTime();
    const endMs = new Date(endSlot.starts_at).getTime();
    const min = Math.min(startMs, endMs);
    const max = Math.max(startMs, endMs);
    const range = availability
      .filter((slot) => {
        const time = new Date(slot.starts_at).getTime();
        return slot.state === "free" && time >= min && time <= max;
      })
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    setSelectedSlots(range);
  }

  function startSlotDrag(slot) {
    if (slot.state !== "free") {
      return;
    }
    setDragStartSlot(slot);
    setIsDraggingSlots(true);
    setSelectedSlots([slot]);
  }

  function moveSlotDrag(slot) {
    if (!isDraggingSlots || !dragStartSlot) {
      return;
    }
    selectSlotRange(dragStartSlot, slot);
  }

  function endSlotDrag(slot) {
    if (isDraggingSlots && dragStartSlot) {
      selectSlotRange(dragStartSlot, slot);
    }
    setIsDraggingSlots(false);
    setDragStartSlot(null);
  }

  function selectCourt(courtId) {
    setActiveCourtId(courtId);
    setView("detail");
  }

  async function startCheckout() {
    if (checkoutInFlight.current) return;
    setError("");
    setSuccess("");
    if (!isAuthed) {
      setError("Увійди в акаунт, щоб забронювати корт.");
      setView("cabinet");
      return;
    }
    if (!activeCourt) {
      setError("Обери корт.");
      return;
    }
    if (!canConfirmSelection) {
      setError("Обери мінімум два суміжні 30-хвилинні слоти.");
      return;
    }
    checkoutInFlight.current = true;
    setCheckoutBusy(true);
    try {
      if (checkoutHold) {
        await api.cancelBooking(checkoutHold.id, { reason: "Changed checkout selection" });
        setCheckoutHold(null);
      }
      const slotStarts = selectedSlots.map((slot) => slot.starts_at);
      const hold = await api.holdBooking({ court_id: activeCourt.id, slot_starts: slotStarts });
      setCheckoutHold({ ...hold, court_name: activeCourt.name, court_address: activeCourt.address });
      setView("checkout");
    } catch (err) {
      setError(err.message);
    } finally {
      checkoutInFlight.current = false;
      setCheckoutBusy(false);
    }
  }

  async function finishCheckout() {
    if (!checkoutHold || checkoutInFlight.current) return;
    checkoutInFlight.current = true;
    setCheckoutBusy(true);
    setError("");
    try {
      const result = await api.checkout({ hold_token: checkoutHold.hold_token });
      setCompletedCheckout({ ...result.booking, court_name: checkoutHold.court_name });
      setCheckoutHold(null);
      setSuccess("Демооплату схвалено. Корт заброньовано.");
      setView("success");
      await loadCabinet();
      await loadAvailability(result.booking.court_id, weekStart);
    } catch (err) {
      setError(err.message);
    } finally {
      checkoutInFlight.current = false;
      setCheckoutBusy(false);
    }
  }

  async function leaveCheckout() {
    if (!checkoutHold || checkoutInFlight.current) return;
    checkoutInFlight.current = true;
    setCheckoutBusy(true);
    setError("");
    try {
      await api.cancelBooking(checkoutHold.id, { reason: "Returned from checkout" });
      setActiveCourtId(checkoutHold.court_id);
      setCheckoutHold(null);
      setView("detail");
      await loadAvailability(checkoutHold.court_id, weekStart);
    } catch (err) {
      setError(err.message);
    } finally {
      checkoutInFlight.current = false;
      setCheckoutBusy(false);
    }
  }

  async function loadAdmin() {
    setError("");
    try {
      const isAdminRole = profile?.role === "admin" || profile?.role === "superuser";
      const bookingsPromise = api.listDashboardBookings();
      const usersPromise = isAdminRole ? api.listAdminUsers() : Promise.resolve([]);
      const rolesPromise = isAdminRole ? api.listRoles() : Promise.resolve([]);
      const policiesPromise = isAdminRole ? api.listPolicies() : Promise.resolve([]);
      const deletionRequestsPromise = isAdminRole
        ? api.listDataDeletionRequests(dataDeletionFilter).catch(() => [])
        : Promise.resolve([]);

      const [users, loadedRoles, loadedPolicies, allBookings, deletionRequests, messages] = await Promise.all([
        usersPromise,
        rolesPromise,
        policiesPromise,
        bookingsPromise,
        deletionRequestsPromise,
        api.listModeratorMessages()
      ]);
      setAdminUsers(users);
      if (users.length > 0) {
        const selected = users.find((item) => item.id === selectedAdminUserId) || users[0];
        setSelectedAdminUserId(selected.id);
        setAdminUserForm({
          id: selected.id,
          full_name: selected.full_name,
          role: selected.role,
          is_active: selected.is_active
        });
      } else {
        setSelectedAdminUserId(null);
        setAdminUserForm(null);
      }
      setRoles(loadedRoles);
      setPolicies(loadedPolicies);
      setPermissionDrafts(buildPermissionDraftMap([...new Set([...defaultRoleNames, ...loadedRoles.map((role) => role.name)])], loadedPolicies));
      setAdminBookings(allBookings);
      setModeratorMessages(messages);
      setDataDeletionRequests(deletionRequests);
      addLog("Loaded admin data", { users, loadedRoles, loadedPolicies, deletionRequests });
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadDataDeletionRequests(filter) {
    try {
      const data = await api.listDataDeletionRequests(filter ?? dataDeletionFilter);
      setDataDeletionRequests(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function approveDataDeletion(requestId) {
    const confirmed = await askForConfirmation(
      "Акаунт користувача та персональні дані буде остаточно видалено.",
      {
        title: "Підтвердити видалення?",
        confirmLabel: "Видалити зараз",
        cancelLabel: "Скасувати",
        tone: "danger"
      }
    );
    if (!confirmed) {
      return;
    }
    try {
      await api.approveDataDeletionRequest(requestId, { note: "Approved by admin" });
      setSuccess("Запит виконано, акаунт видалено.");
      await loadAdmin();
    } catch (err) {
      setError(err.message);
    }
  }

  async function rejectDataDeletion(requestId) {
    const confirmed = await askForConfirmation(
      "Користувача буде сповіщено, що запит відхилено. Підстава має бути законною (GDPR Art. 17.3).",
      {
        title: "Відхилити запит?",
        confirmLabel: "Відхилити",
        cancelLabel: "Залишити"
      }
    );
    if (!confirmed) {
      return;
    }
    try {
      await api.rejectDataDeletionRequest(requestId, { note: "Rejected by admin" });
      setSuccess("Запит відхилено.");
      await loadAdmin();
    } catch (err) {
      setError(err.message);
    }
  }

  async function refreshAdminAndCourts() {
    await Promise.all([loadAdmin(), loadCourts()]);
  }

  async function remindBooking(bookingId) {
    const comment = (bookingRemindComments[bookingId] || "").trim();
    try {
      await api.remindBooking(bookingId, { comment });
      setSuccess("Нагадування надіслано.");
      setBookingRemindComments((current) => ({ ...current, [bookingId]: "" }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function createAdminUser(event) {
    event.preventDefault();
    try {
      await api.createAdminUser(newUser);
      setNewUser({ email: "", full_name: "", password: "ChangeMeNow123!", role: "user" });
      setSuccess("User created.");
      await loadAdmin();
    } catch (err) {
      setError(err.message);
    }
  }

  function openUserEditor(user) {
    setSelectedAdminUserId(user.id);
    setAdminUserForm({
      id: user.id,
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active
    });
  }

  async function saveUserEditor(event) {
    event.preventDefault();
    if (!adminUserForm?.id) {
      return;
    }
    try {
      await api.updateAdminUser(adminUserForm.id, {
        full_name: adminUserForm.full_name,
        role: adminUserForm.role,
        is_active: Boolean(adminUserForm.is_active)
      });
      setSuccess("User updated.");
      await loadAdmin();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createRole(event) {
    event.preventDefault();
    if (!newRole.trim()) {
      return;
    }
    try {
      await api.createRole({ name: newRole.trim() });
      setNewRole("");
      await loadAdmin();
    } catch (err) {
      setError(err.message);
    }
  }

  function updatePermissionDraft(roleName, endpoint, method, patch) {
    const key = permissionKey(endpoint, method);
    setPermissionDrafts((current) => ({
      ...current,
      [roleName]: {
        ...(current[roleName] || {}),
        [key]: {
          ...(current[roleName]?.[key] || {
            endpoint,
            method,
            allowed: false,
            ownership: "all",
            policyId: null
          }),
          ...patch
        }
      }
    }));
  }

  async function saveMethodPermissions(endpoint, method) {
    setError("");
    setSuccess("");

    try {
      for (const roleName of allRoleNames) {
        const key = permissionKey(endpoint, method);
        const draft = permissionDrafts[roleName]?.[key] || { allowed: false, ownership: "all" };
        const existing = policies
          .map(normalizePolicyFields)
          .find((policy) => policy.role === roleName && policy.endpoint === endpoint && policy.method === method);
          if (draft.allowed) {
            const payload = {
              role: roleName,
              resource: endpoint,
              action: method,
              effect: "allow",
              condition: `ownership:${draft.ownership || "all"}`
            };
            if (existing?.id) {
              await api.updatePolicy(existing.id, payload);
            } else {
              await api.createPolicy(payload);
            }
          } else if (existing?.id) {
            await api.deletePolicy(existing.id);
          }
      }

      setSuccess(`Permissions updated for ${endpoint} ${method.toUpperCase()}.`);
      await loadAdmin();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createCourt(event) {
    event.preventDefault();
    try {
      await api.createCourt({ ...newCourt, price_per_hour: Number(newCourt.price_per_hour) });
      setNewCourt({
        name: "",
        city: "Kyiv",
        district: "Pechersk",
        address: "",
        surface: "Hard",
        price_per_hour: 700,
        opening_time: "07:00",
        closing_time: "22:00",
        image_url: ""
      });
      await loadCourts();
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateCourtPrice(courtId, price) {
    try {
      await api.updateCourt(courtId, { price_per_hour: Number(price) });
      await loadCourts();
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateCourtHours(courtId, openingTime, closingTime) {
    try {
      await api.updateCourt(courtId, { opening_time: openingTime, closing_time: closingTime });
      await loadCourts();
      if (courtId === activeCourtId) {
        await loadAvailability(courtId, weekStart);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateCourtImage(courtId, imageUrl) {
    try {
      await api.updateCourt(courtId, { image_url: imageUrl || null });
      await loadCourts();
    } catch (err) {
      setError(err.message);
    }
  }

  async function uploadCourtImageFile(courtId, file) {
    if (!file) {
      return;
    }
    try {
      const uploaded = await api.uploadCourtImage(courtId, file);
      setAdminCourtForm((current) =>
        current && current.id === courtId ? { ...current, image_url: uploaded.image_url || current.image_url } : current
      );
      await loadCourts();
      setSuccess("Court image uploaded.");
    } catch (err) {
      setError(err.message);
    }
  }

  function openCourtEditor(court) {
    setSelectedAdminCourtId(court.id);
    setAdminCourtForm({ ...court });
  }

  function resolveCourtImageUrl(court) {
    if (!court?.image_url) {
      return "";
    }
    if (court.image_url.startsWith("http")) {
      return court.image_url;
    }
    return `${API_ORIGIN}${court.image_url}`;
  }

  async function saveCourtEditor(event) {
    event.preventDefault();
    if (!adminCourtForm?.id) {
      return;
    }
    try {
      await api.updateCourt(adminCourtForm.id, {
        name: adminCourtForm.name,
        city: adminCourtForm.city,
        district: adminCourtForm.district,
        address: adminCourtForm.address,
        surface: adminCourtForm.surface,
        price_per_hour: Number(adminCourtForm.price_per_hour),
        opening_time: adminCourtForm.opening_time,
        closing_time: adminCourtForm.closing_time,
        image_url: adminCourtForm.image_url || null
      });
      setSuccess("Court updated.");
      await loadCourts();
    } catch (err) {
      setError(err.message);
    }
  }

  async function triggerNotification() {
    setError("");
    try {
      const result = await api.sendNotification({
        subject: "Courtly Campaign",
        body: "System message from dashboard.",
        recipient_scope: "active_users"
      });
      addLog("Notification queued", result);
    } catch (err) {
      setError(err.message);
    }
  }

  async function triggerReplay() {
    setError("");
    try {
      const result = await api.replayEventLog();
      addLog("Replay finished", result);
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleFavorite(courtId) {
    if (!isAuthed) {
      setView("cabinet");
      setError("Увійди, щоб зберігати обране.");
      return;
    }
    const wasFavorite = favorites.includes(courtId);
    if (wasFavorite) {
      const confirmed = await askForConfirmation("Прибрати цей корт з обраного?", {
        title: "Прибрати з обраного",
        confirmLabel: "Прибрати"
      });
      if (!confirmed) {
        return;
      }
    }
    setFavorites((current) =>
      current.includes(courtId) ? current.filter((item) => item !== courtId) : [...current, courtId]
    );
    try {
      if (wasFavorite) {
        await api.removeFavorite(courtId);
      } else {
        await api.addFavorite({ court_id: courtId });
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteAdminUser(userId) {
    const confirmed = await askForConfirmation("Цю дію не можна скасувати.", {
      title: "Видалити користувача?",
      confirmLabel: "Видалити",
      tone: "danger"
    });
    if (!confirmed) {
      return;
    }
    try {
      await api.deleteAdminUser(userId);
      await loadAdmin();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteRole(roleId) {
    const confirmed = await askForConfirmation("Роль буде остаточно видалено.", {
      title: "Видалити роль?",
      confirmLabel: "Видалити",
      tone: "danger"
    });
    if (!confirmed) {
      return;
    }
    try {
      await api.deleteRole(roleId);
      await loadAdmin();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteCourt(courtId) {
    const confirmed = await askForConfirmation("Корт зникне з каталогу для всіх користувачів.", {
      title: "Видалити корт?",
      confirmLabel: "Видалити",
      tone: "danger"
    });
    if (!confirmed) {
      return;
    }
    try {
      await api.deleteCourt(courtId);
      await loadCourts();
    } catch (err) {
      setError(err.message);
    }
  }

  const nav = [
    ["home", "Головна"],
    ["search", "Корти"]
  ];
  if (isAuthed && isManager) {
    nav.push(["admin", "Дашборд"]);
  }

  function navigateTo(nextView) {
    setView(nextView);
    setIsMobileMenuOpen(false);
    setIsProfileMenuOpen(false);
  }

  function toggleCourtFilter(filterName) {
    setActiveCourtFilters((current) =>
      current.includes(filterName) ? current.filter((item) => item !== filterName) : [...current, filterName]
    );
  }

  const isCheckoutPage = view === "checkout" || view === "success";

  return (
    <div className={isCheckoutPage ? "app-shell checkout-shell" : "app-shell"}>
      {!isCheckoutPage ? <>
      <header className="topbar">
        <div onClick={() => navigateTo("home")}>
          <Logo />
        </div>
        <button
          className={isMobileMenuOpen ? "burger-button active" : "burger-button"}
          onClick={() => setIsMobileMenuOpen((current) => !current)}
          aria-label="Toggle menu"
          aria-expanded={isMobileMenuOpen}
          type="button"
        >
          <span />
          <span />
          <span />
        </button>
        <nav className="nav-tabs" aria-label="Primary navigation">
          {nav.map(([id, label]) => (
            <button key={id} className={view === id ? "nav-tab active" : "nav-tab"} onClick={() => navigateTo(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          {isAuthed ? (
            <div className="profile-menu" ref={profileMenuRef}>
              <button
                className={isProfileMenuOpen ? "profile-trigger open" : "profile-trigger"}
                onClick={() => setIsProfileMenuOpen((current) => !current)}
                aria-expanded={isProfileMenuOpen}
                aria-haspopup="menu"
                type="button"
              >
                <span className="profile-avatar" aria-hidden="true">
                  {profile?.full_name?.slice(0, 1) || "U"}
                </span>
              </button>
              {isProfileMenuOpen ? (
                <div className="profile-dropdown" role="menu">
                  <button className="profile-dropdown-item" role="menuitem" onClick={() => navigateTo("cabinet")}>
                    Переглянути профіль
                  </button>
                  <button
                    className="profile-dropdown-item danger"
                    role="menuitem"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      setIsProfileMenuOpen(false);
                      logout();
                    }}
                  >
                    Вийти
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button className="primary-button compact user-button" onClick={() => navigateTo("cabinet")}>
              Увійти
            </button>
          )}
        </div>
      </header>
      <div className={isMobileMenuOpen ? "mobile-menu-backdrop open" : "mobile-menu-backdrop"} onClick={() => setIsMobileMenuOpen(false)} />
      <aside className={isMobileMenuOpen ? "mobile-menu open" : "mobile-menu"} aria-label="Mobile navigation">
        <nav className="mobile-menu-nav">
          {nav.map(([id, label]) => (
            <button key={id} className={view === id ? "mobile-menu-link active" : "mobile-menu-link"} onClick={() => navigateTo(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="mobile-menu-footer">
          <button className="primary-button full" onClick={() => navigateTo("cabinet")}>
            {isAuthed ? profile?.full_name || "Account" : "Увійти"}
          </button>
          {isAuthed ? (
            <button
              className="secondary-button full"
              onClick={() => {
                setIsMobileMenuOpen(false);
                logout();
              }}
            >
              Вийти
            </button>
          ) : null}
        </div>
      </aside>
      </> : null}

      <main className={isCheckoutPage ? "checkout-main" : undefined}>
        {view === "home" ? (
          <section className="hero-section">
            <div className="hero-content">
              <h1 className="hero-title" style={{ fontSize: "10vw", minWidth: "100%", position: "relative", top: "0", left: "0" }}>FIND YOUR COURT</h1>

              <div className="search-panel">
                <label>
                  <span>Місто</span>
                  <select value={city} onChange={(event) => setCity(event.target.value)}>
                    <option>Kyiv</option>
                    <option>All cities</option>
                  </select>
                </label>
                <label>
                  <span>Район</span>
                  <select value={district} onChange={(event) => setDistrict(event.target.value)}>
                    <option>All districts</option>
                    <option>Pechersk</option>
                    <option>Podil</option>
                    <option>Obolon</option>
                  </select>
                </label>
                <label>
                  <span>Тиждень</span>
                  <input
                    type="date"
                    value={dateKey(weekStart)}
                    onChange={(event) => setWeekStart(startOfWeek(new Date(event.target.value)))}
                  />
                </label>
                <button className="primary-button" onClick={() => setView("search")}>
                  Знайти корт
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {view === "home" ? (
          <section className="content-section">
            <div className="section-heading compact-heading">
              <h2>Як це працює?</h2>
            </div>
            <div className="steps-grid premium-steps">
              {[
                ["01", "Обери корт", "Знайди корт поруч."],
                ["02", "Обери час", "Відміть вільний слот."],
                ["03", "Підтвердь", "Готово, бронь активна."]
              ].map(([num, title, text]) => (
                <article className="step-card" key={num}>
                  <span>{num}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {view === "search" ? (
          <section className="product-layout">
            <div className="results-column">
              <div className="section-heading inline">
                <div>
                  <span className="eyebrow dark">Courts</span>
                  <h2>Обери корт</h2>
                </div>
              </div>

              <div className="filter-row">
                {filterChipOptions.map((chip) => (
                  <button
                    key={chip}
                    className={activeCourtFilters.includes(chip) ? "chip active" : "chip"}
                    onClick={() => toggleCourtFilter(chip)}
                    type="button"
                  >
                    {chip}
                  </button>
                ))}
              </div>

              <div className="court-list">
                {filteredCourts.map((court) => (
                  <article
                    className={court.id === activeCourt?.id ? "court-card active" : "court-card"}
                    key={court.id}
                    onMouseEnter={() => setActiveCourtId(court.id)}
                    onClick={() => selectCourt(court.id)}
                  >
                    <button
                      className={favorites.includes(court.id) ? "favorite active" : "favorite"}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleFavorite(court.id);
                      }}
                      aria-label="Toggle favorite"
                    >
                      {favorites.includes(court.id) ? "В обраному" : "Зберегти"}
                    </button>
                    <div
                      className="court-image"
                      style={
                        court.image_url
                          ? {
                              backgroundImage: `url(${resolveCourtImageUrl(court)})`,
                              backgroundSize: "cover",
                              backgroundPosition: "center"
                            }
                          : { background: court.image }
                      }
                    />
                    <div className="court-card-body">
                      <div>
                        <h3>{court.name}</h3>
                        <p>{court.address} - {court.district}</p>
                      </div>
                      <div className="meta-grid">
                        <span>{court.surface}</span>
                        <span>{court.rating} ★</span>
                        <span>{court.distance}</span>
                      </div>
                      <div className="court-card-footer">
                        <div>
                          <span className="caption">ціна</span>
                          <strong>{formatMoney(court.price_per_hour)} / h</strong>
                        </div>
                        <div>
                          <span className="caption">слот</span>
                          <strong>{court.nextSlot}</strong>
                        </div>
                        <button
                          className="primary-button small"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectCourt(court.id);
                          }}
                        >
                          Обрати
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>

            <aside className="map-panel">
              <div className="map-top">
                <div>
                  <span className="eyebrow dark">Мапа</span>
                  <h3>Карта кортів</h3>
                </div>
              </div>
              <CourtsMap activeCourt={activeCourt} courts={filteredCourts} onSelectCourt={setActiveCourtId} />
            </aside>
          </section>
        ) : null}

        {view === "detail" && activeCourt ? (
          <section className="detail-layout calendar-wide-layout">
            <div className="detail-main">
              <div
                className="detail-hero compact-court-hero"
                style={
                  activeCourt.image_url
                    ? {
                        backgroundImage: `url(${resolveCourtImageUrl(activeCourt)})`,
                        backgroundSize: "cover",
                        backgroundPosition: "center"
                      }
                    : { background: activeCourt.image }
                }
              >
                <div className="detail-title-card">
                  <span className="eyebrow dark">Корт</span>
                  <h1>{activeCourt.name}</h1>
                  <p>{activeCourt.address} - {activeCourt.city}, {activeCourt.district}</p>
                  <div className="meta-grid compact-meta">
                    <span>{activeCourt.rating} ★</span>
                    <span>{activeCourt.surface}</span>
                    <span>{formatMoney(activeCourt.price_per_hour)} / h</span>
                    <span>{activeCourt.opening_time} - {activeCourt.closing_time}</span>
                  </div>
                </div>
              </div>

              <section className="slot-section calendar-fullbleed">
                <div className="section-heading inline">
                  <div>
                    <span className="eyebrow dark">Календар</span>
                    <h2>Тижневий календар</h2>
                  </div>
                  <div className="calendar-controls">
                    <button className="secondary-button compact" onClick={() => setWeekStart(addDays(weekStart, -7))}>
                      Назад
                    </button>
                    <strong>
                      {displayDate(weekDays[0])} - {displayDate(weekDays[6])}
                    </strong>
                    <button className="secondary-button compact" onClick={() => setWeekStart(addDays(weekStart, 7))}>
                      Далі
                    </button>
                  </div>
                </div>
                <div
                  className="week-calendar"
                  role="grid"
                  aria-label="Weekly availability calendar"
                  onMouseLeave={() => {
                    setIsDraggingSlots(false);
                    setDragStartSlot(null);
                  }}
                >
                  {weekDays.map((day, index) => {
                    const slots = weekSlots.get(dateKey(day)) || [];
                    return (
                      <div className="calendar-day" key={dateKey(day)}>
                        <div className="calendar-day-head">
                          <span>{dayLabels[index]}</span>
                          <strong>{displayDate(day)}</strong>
                        </div>
                        <div className="calendar-slots">
                          {slots.length === 0 ? <span className="empty-day">Немає слотів</span> : null}
                          {slots.slice(0, 24).map((slot) => {
                            const selected = selectedSlots.some((item) => sameSlot(item.starts_at, slot.starts_at));
                            return (
                              <button
                                key={slot.starts_at}
                                className={`calendar-slot ${slot.state} ${selected ? "selected" : ""}`}
                                disabled={slot.state !== "free"}
                                onClick={() => toggleSlot(slot)}
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  startSlotDrag(slot);
                                }}
                                onMouseEnter={() => moveSlotDrag(slot)}
                                onMouseUp={() => endSlotDrag(slot)}
                                onTouchStart={() => startSlotDrag(slot)}
                                onTouchMove={() => moveSlotDrag(slot)}
                                onTouchEnd={() => endSlotDrag(slot)}
                              >
                                <span>{displayTime(slot.starts_at)}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="reviews-section">
                <div className="section-heading inline">
                  <div>
                    <span className="eyebrow dark">Відгуки</span>
                    <h2>Що кажуть гравці</h2>
                  </div>
                </div>
                <div className="reviews-grid">
                  {courtReviews.length === 0 ? <div className="empty-state">Поки немає відгуків.</div> : null}
                  {courtReviews.map((review) => (
                    <article className="review-card" key={review.id} data-author-email={review.author_email}>
                      <strong>{review.rating} ★</strong>
                      <p>{review.comment}</p>
                      <span>{new Date(review.created_at).toLocaleDateString()}</span>
                    </article>
                  ))}
                </div>
              </section>
            </div>

            <aside className="booking-summary">
              <span className="eyebrow dark">Бронювання</span>
              <h2>{activeCourt.name}</h2>
              <div className="summary-list">
                <div>
                  <span>Дата</span>
                  <strong>{selectedSlots[0] ? displayDate(selectedSlots[0].starts_at) : "Обери слот"}</strong>
                </div>
                <div>
                  <span>Час</span>
                  <strong>
                    {selectedSlots.length > 0
                      ? `${displayTime(selectedSlots[0].starts_at)} - ${displayTime(addMinutes(new Date(selectedSlots[selectedSlots.length - 1].starts_at), 30))}`
                      : "Обери слоти"}
                  </strong>
                </div>
                <div>
                  <span>Тривалість</span>
                  <strong>{selectedDuration} min</strong>
                </div>
                <div>
                  <span>Разом</span>
                  <strong>{formatMoney(selectedTotal)}</strong>
                </div>
              </div>
              <p className={canConfirmSelection ? "hint success" : "hint warning"}>{slotHint}</p>
              <button className="primary-button full" onClick={startCheckout} disabled={checkoutBusy || (selectedSlots.length > 0 && !canConfirmSelection)}>
                {checkoutBusy ? "Готуємо оплату…" : isAuthed ? "Перейти до оплати" : "Увійти і забронювати"}
              </button>
              <button className="secondary-button full" onClick={() => toggleFavorite(activeCourt.id)}>
                {favorites.includes(activeCourt.id) ? "Прибрати з обраного" : "Додати в обране"}
              </button>
              <div className="summary-list">
                <h3>Останні бронювання</h3>
                {courtBookings.length === 0 ? <span>Немає бронювань.</span> : null}
                {courtBookings.slice(0, 5).map((booking) => (
                  <div key={booking.id}>
                    <span>{new Date(booking.starts_at).toLocaleDateString()}</span>
                    <strong>{displayTime(booking.starts_at)} - {displayTime(booking.ends_at)}</strong>
                  </div>
                ))}
              </div>
            </aside>
          </section>
        ) : null}

        {view === "checkout" && checkoutHold ? (
          <section className="checkout-panel booking-summary">
            <span className="eyebrow dark">Оформлення бронювання</span>
            <h1>Оплата</h1>
            <h2>{checkoutHold.court_name}</h2>
            <p>{checkoutHold.court_address}</p>
            <div className="summary-list">
              <div><span>Дата</span><strong>{displayLongDate(checkoutHold.starts_at)}</strong></div>
              <div><span>Час</span><strong>{displayTime(checkoutHold.starts_at)} – {displayTime(checkoutHold.ends_at)}</strong></div>
              <div><span>Тривалість</span><strong>{bookingDurationMinutes(checkoutHold.starts_at, checkoutHold.ends_at)} хв</strong></div>
              <div><span>До сплати</span><strong>{formatMoney(checkoutHold.total_price)}</strong></div>
            </div>
            <p className="hint warning">Демооплата: кожен платіж автоматично схвалюється. Кошти не списуються, дані картки не потрібні.</p>
            <p>Слоти утримуються 5 хвилин. Заверши оформлення до {displayTime(checkoutHold.held_until)}.</p>
            <button className="primary-button full" onClick={finishCheckout} disabled={checkoutBusy}>
              {checkoutBusy ? "Обробляємо…" : `Оплатити ${formatMoney(checkoutHold.total_price)} (демо)`}
            </button>
            <button className="secondary-button full" onClick={leaveCheckout} disabled={checkoutBusy}>Повернутися до вибору часу</button>
          </section>
        ) : null}

        {view === "success" && completedCheckout ? (
          <section className="success-state">
            <div className="success-illustration">Booked</div>
            <h1>Корт заброньовано</h1>
            <p>
              {completedCheckout.court_name}, {displayDate(completedCheckout.starts_at)},{" "}
              {displayTime(completedCheckout.starts_at)} – {displayTime(completedCheckout.ends_at)}
            </p>
            <p>Демооплату {formatMoney(completedCheckout.total_price)} схвалено. Кошти не списано.</p>
            <div className="row-actions centered">
              <button className="primary-button" onClick={() => setView("cabinet")}>
                Переглянути мої бронювання
              </button>
              <button className="secondary-button" onClick={() => setView("search")}>
                Повернутись до пошуку
              </button>
            </div>
          </section>
        ) : null}

        {view === "cabinet" ? (
          !isAuthed ? (
            <section className="content-section">
              <section className="auth-screen">
                <div className="auth-card">
                  <img src={logoUrl} alt="Courtly" className="auth-logo" />
                  <h2>{authMode === "signup" ? "Create an account" : "Sign in"}</h2>
                  <form
                    className="auth-form"
                    onSubmit={
                      authMode === "signup"
                        ? handleRegister
                        : emailVerificationChallengeToken
                          ? handleVerifyEmail
                          : mfaChallengeToken
                            ? handleVerifyMfa
                            : handleLogin
                    }
                  >
                    {authMode === "signup" ? (
                      <div className="auth-two-columns">
                        <label>
                          <span>First name</span>
                          <input value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="Vasya" required />
                        </label>
                        <label>
                          <span>Last name</span>
                          <input value={lastName} onChange={(event) => setLastName(event.target.value)} placeholder="Pupkin" required />
                        </label>
                      </div>
                    ) : null}
                    {!emailVerificationChallengeToken && !mfaChallengeToken ? (
                      <>
                        <label>
                          <span>Email</span>
                          <input
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            placeholder="example@email.com"
                            type="email"
                            required
                          />
                        </label>
                        <label>
                          <span>Password</span>
                          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required />
                        </label>
                      </>
                    ) : emailVerificationChallengeToken ? (
                      <>
                        <label>
                          <span>6-digit email verification code</span>
                          <input
                            value={emailVerificationCode}
                            onChange={(event) => setEmailVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                            inputMode="numeric"
                            pattern="[0-9]{6}"
                            placeholder="123456"
                            required
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label>
                          <span>6-digit verification code</span>
                          <input
                            value={mfaCode}
                            onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                            inputMode="numeric"
                            pattern="[0-9]{6}"
                            placeholder="123456"
                            required
                          />
                        </label>
                      </>
                    )}
                    {authMode === "signup" ? (
                      <div className="password-strength-block" role="status" aria-live="polite">
                        <div className={`password-strength-chip ${signupPasswordStrength}`}>
                          Strength: {signupPasswordStrength}
                        </div>
                        <ul className="password-policy-list">
                          <li className={signupPasswordPolicy.minLength ? "ok" : "fail"}>Minimum 8 symbols</li>
                          <li className={signupPasswordPolicy.hasUpper ? "ok" : "fail"}>Uppercase letter (A-Z)</li>
                          <li className={signupPasswordPolicy.hasLower ? "ok" : "fail"}>Lowercase letter (a-z)</li>
                          <li className={signupPasswordPolicy.hasDigit ? "ok" : "fail"}>Number (0-9)</li>
                          <li className={signupPasswordPolicy.hasSpecial ? "ok" : "fail"}>Special symbol (!@#...)</li>
                        </ul>
                      </div>
                    ) : null}
                    {authMode === "signup" ? (
                      <>
                        <label>
                          <span>Confirm password</span>
                          <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" required />
                        </label>
                        <label className="terms-row">
                          <input
                            checked={acceptedTerms}
                            onChange={(event) => setAcceptedTerms(event.target.checked)}
                            type="checkbox"
                          />
                          <span>I agree to the Privacy Policy and Terms of Service</span>
                        </label>
                      </>
                    ) : null}
                    <button className="primary-button full auth-submit" type="submit">
                      {authMode === "signup"
                        ? "Sign up"
                        : emailVerificationChallengeToken
                          ? "Verify email"
                          : mfaChallengeToken
                            ? "Verify code"
                            : "Sign in"}
                    </button>
                    {authMode === "signin" && (mfaChallengeToken || emailVerificationChallengeToken) ? (
                      <button
                        className="secondary-button full"
                        type="button"
                        onClick={() => {
                          setMfaChallengeToken("");
                          setMfaCode("");
                          setMfaDevCode("");
                          setEmailVerificationChallengeToken("");
                          setEmailVerificationCode("");
                          setEmailVerificationDevCode("");
                          setSuccess("");
                        }}
                      >
                        Back to login
                      </button>
                    ) : null}
                  </form>
                  <button
                    className="auth-switch"
                    onClick={() => {
                      setAuthMode(authMode === "signup" ? "signin" : "signup");
                      setMfaChallengeToken("");
                      setMfaCode("");
                      setMfaDevCode("");
                      setEmailVerificationChallengeToken("");
                      setEmailVerificationCode("");
                      setEmailVerificationDevCode("");
                    }}
                    type="button"
                  >
                    {authMode === "signup" ? "Have an account? Sign in" : "No account? Sign up"}
                  </button>
                </div>
              </section>
            </section>
          ) : (
            <section className="profile-page">
              <header className="profile-hero">
                <div className="profile-hero-main">
                  <div className="profile-hero-identity">
                    <div className="profile-avatar-xl">{getInitials(profile?.full_name)}</div>
                    <div className="profile-hero-text">
                      <span className="eyebrow dark">Мій профіль</span>
                      <h1>{profile?.full_name || "Гість"}</h1>
                      <div className="profile-hero-meta">
                        <span className="role-chip">{profile?.role || "user"}</span>
                        <span className="profile-hero-email">{profile?.email}</span>
                        {profile?.phone ? <span className="profile-hero-phone">{profile.phone}</span> : null}
                      </div>
                    </div>
                  </div>
                  <div className="profile-hero-actions">
                    {!isEditingProfile ? (
                      <button className="primary-button compact" type="button" onClick={startEditProfile}>
                        Редагувати профіль
                      </button>
                    ) : null}
                    <button className="secondary-button compact" type="button" onClick={logout}>
                      Вийти
                    </button>
                  </div>
                </div>
                <div className="profile-stats">
                  <article className="stat-card stat-primary">
                    <span className="stat-label">Майбутні</span>
                    <strong className="stat-value">{bookingGroups.upcoming.length}</strong>
                    <small>Бронювання попереду</small>
                  </article>
                  <article className="stat-card">
                    <span className="stat-label">Завершено</span>
                    <strong className="stat-value">{bookingGroups.past.length}</strong>
                    <small>Минулих бронювань</small>
                  </article>
                  <article className="stat-card">
                    <span className="stat-label">Обране</span>
                    <strong className="stat-value">{favorites.length}</strong>
                    <small>Збережених кортів</small>
                  </article>
                  <article className="stat-card">
                    <span className="stat-label">Відгуки</span>
                    <strong className="stat-value">{myReviews.length}</strong>
                    <small>Залишено</small>
                  </article>
                  <article className="stat-card stat-accent">
                    <span className="stat-label">Витрачено</span>
                    <strong className="stat-value">{formatMoney(totalSpent)}</strong>
                    <small>За весь час</small>
                  </article>
                </div>
              </header>

              <div className="profile-layout">
                <aside className="profile-sidebar">
                  <nav className="profile-section-nav" aria-label="Profile sections">
                    {[
                      ["bookings", "Бронювання", bookings.length],
                      ["favorites", "Обране", favorites.length],
                      ["reviews", "Відгуки", myReviews.length],
                      ["settings", "Налаштування", null]
                    ].map(([id, label, count]) => (
                      <button
                        key={id}
                        type="button"
                        className={cabinetTab === id ? "profile-section-link active" : "profile-section-link"}
                        onClick={() => setCabinetTab(id)}
                      >
                        <span>{label}</span>
                        {typeof count === "number" ? <em>{count}</em> : null}
                      </button>
                    ))}
                  </nav>

                  <article className="profile-edit-card">
                    <header>
                      <h3>Особисті дані</h3>
                      {!isEditingProfile ? (
                        <button className="link-button" type="button" onClick={startEditProfile}>
                          Редагувати
                        </button>
                      ) : null}
                    </header>
                    {!isEditingProfile ? (
                      <dl className="profile-fact-list">
                        <div>
                          <dt>Ім'я</dt>
                          <dd>{profile?.full_name || "—"}</dd>
                        </div>
                        <div>
                          <dt>Email</dt>
                          <dd>{profile?.email}</dd>
                        </div>
                        <div>
                          <dt>Телефон</dt>
                          <dd>{profile?.phone || "—"}</dd>
                        </div>
                        <div>
                          <dt>Роль</dt>
                          <dd>{profile?.role}</dd>
                        </div>
                      </dl>
                    ) : (
                      <form className="profile-edit-form" onSubmit={saveProfileEdits}>
                        <label>
                          <span>Повне ім'я</span>
                          <input
                            value={profileDraft.full_name}
                            onChange={(event) => setProfileDraft((current) => ({ ...current, full_name: event.target.value }))}
                            placeholder="Ім'я Прізвище"
                            required
                          />
                        </label>
                        <label>
                          <span>Телефон</span>
                          <input
                            value={profileDraft.phone}
                            onChange={(event) => setProfileDraft((current) => ({ ...current, phone: event.target.value }))}
                            placeholder="+380..."
                            type="tel"
                          />
                        </label>
                        <label className="profile-readonly-field">
                          <span>Email</span>
                          <input value={profile?.email || ""} disabled readOnly />
                        </label>
                        <div className="row-actions">
                          <button className="primary-button compact" type="submit">
                            Зберегти
                          </button>
                          <button className="secondary-button compact" type="button" onClick={cancelEditProfile}>
                            Скасувати
                          </button>
                        </div>
                      </form>
                    )}
                  </article>
                </aside>

                <main className="profile-content">
                  {cabinetTab === "bookings" ? (
                    <section className="profile-panel">
                      <div className="profile-panel-head">
                        <div>
                          <span className="eyebrow dark">Бронювання</span>
                          <h2>Мої бронювання</h2>
                        </div>
                        <div className="filter-row tight">
                          {[
                            ["upcoming", "Майбутні", bookingGroups.upcoming.length],
                            ["past", "Минулі", bookingGroups.past.length],
                            ["cancelled", "Скасовані", bookingGroups.cancelled.length],
                            ["all", "Усі", bookings.length]
                          ].map(([id, label, count]) => (
                            <button
                              key={id}
                              type="button"
                              className={bookingStatusFilter === id ? "chip active" : "chip"}
                              onClick={() => setBookingStatusFilter(id)}
                            >
                              {label}
                              <em className="chip-count">{count}</em>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="bookings-grid">
                        {visibleBookings.length === 0 ? (
                          <div className="empty-state large">
                            <strong>Тут поки порожньо.</strong>
                            <span>Знайди корт і заброньуй слот, щоб він з'явився тут.</span>
                            <button className="primary-button compact" type="button" onClick={() => navigateTo("search")}>
                              Знайти корт
                            </button>
                          </div>
                        ) : null}
                        {visibleBookings.map((booking) => {
                          const info = bookingStatusInfo(booking);
                          const canCancel = isBookingCancellable(booking);
                          const courtImage = booking.court_image_url
                            ? booking.court_image_url.startsWith("http")
                              ? booking.court_image_url
                              : `${API_ORIGIN}${booking.court_image_url}`
                            : null;
                          return (
                            <article className={`booking-card ${info.tone}`} key={booking.id}>
                              <div
                                className="booking-card-image"
                                style={
                                  courtImage
                                    ? { backgroundImage: `url(${courtImage})` }
                                    : { background: courtVisuals[(booking.court_name || booking.court_id).length % courtVisuals.length] }
                                }
                              >
                                <span className={`status-badge ${info.tone}`}>{info.label}</span>
                              </div>
                              <div className="booking-card-body">
                                <div className="booking-card-head">
                                  <h3>{booking.court_name || booking.court_id}</h3>
                                  <p>{booking.court_address}{booking.court_district ? ` · ${booking.court_district}` : ""}</p>
                                </div>
                                <div className="booking-card-facts">
                                  <div>
                                    <span>Дата</span>
                                    <strong>{displayLongDate(booking.starts_at)}</strong>
                                  </div>
                                  <div>
                                    <span>Час</span>
                                    <strong>{displayTime(booking.starts_at)} – {displayTime(booking.ends_at)}</strong>
                                  </div>
                                  <div>
                                    <span>Тривалість</span>
                                    <strong>{bookingDurationMinutes(booking.starts_at, booking.ends_at)} хв</strong>
                                  </div>
                                  <div>
                                    <span>Сума</span>
                                    <strong>{formatMoney(booking.total_price)}</strong>
                                  </div>
                                </div>
                                <div className="booking-card-actions">
                                  <button className="primary-button compact" type="button" onClick={() => loadBookingDetail(booking.id)}>
                                    Деталі
                                  </button>
                                  <button className="secondary-button compact" type="button" onClick={() => selectCourt(booking.court_id)}>
                                    До корту
                                  </button>
                                  {canCancel ? (
                                    <button className="danger-button compact" type="button" onClick={() => cancelMyBooking(booking.id)}>
                                      Скасувати
                                    </button>
                                  ) : null}
                                  {booking.has_review ? <span className="muted-pill">Відгук залишено</span> : null}
                                </div>
                                {booking.status === "cancelled" && booking.canceled_reason ? (
                                  <p className="cancel-reason">Причина: {booking.canceled_reason}</p>
                                ) : null}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  ) : null}

                  {cabinetTab === "favorites" ? (
                    <section className="profile-panel">
                      <div className="profile-panel-head">
                        <div>
                          <span className="eyebrow dark">Обране</span>
                          <h2>Збережені корти</h2>
                        </div>
                      </div>
                      <div className="favorites-grid">
                        {favorites.length === 0 ? (
                          <div className="empty-state large">
                            <strong>Ще немає обраного.</strong>
                            <span>Додавай корти у обране кнопкою «Зберегти» на картці корту.</span>
                            <button className="primary-button compact" type="button" onClick={() => navigateTo("search")}>
                              Обрати корт
                            </button>
                          </div>
                        ) : null}
                        {favorites.map((courtId) => {
                          const court = courts.find((item) => item.id === courtId);
                          const image = court?.image_url
                            ? court.image_url.startsWith("http")
                              ? court.image_url
                              : `${API_ORIGIN}${court.image_url}`
                            : null;
                          return (
                            <article className="favorite-card" key={courtId}>
                              <div
                                className="favorite-card-image"
                                style={image ? { backgroundImage: `url(${image})` } : { background: court?.image || courtVisuals[0] }}
                              />
                              <div className="favorite-card-body">
                                <h3>{court?.name || "Невідомий корт"}</h3>
                                <p>{court ? `${court.address} · ${court.district}` : "Корт"}</p>
                                <div className="meta-grid">
                                  {court?.surface ? <span>{court.surface}</span> : null}
                                  {court?.rating ? <span>{court.rating} ★</span> : null}
                                  {court ? <span>{formatMoney(court.price_per_hour)} / h</span> : null}
                                </div>
                                <div className="row-actions">
                                  <button className="primary-button compact" type="button" onClick={() => selectCourt(courtId)}>
                                    Відкрити корт
                                  </button>
                                  <button className="secondary-button compact" type="button" onClick={() => toggleFavorite(courtId)}>
                                    Прибрати
                                  </button>
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  ) : null}

                  {cabinetTab === "reviews" ? (
                    <section className="profile-panel">
                      <div className="profile-panel-head">
                        <div>
                          <span className="eyebrow dark">Відгуки</span>
                          <h2>Мої відгуки</h2>
                        </div>
                      </div>
                      <div className="my-reviews-grid">
                        {myReviews.length === 0 ? (
                          <div className="empty-state large">
                            <strong>Поки немає відгуків.</strong>
                            <span>Залиш свій відгук після гри в деталях бронювання.</span>
                          </div>
                        ) : null}
                        {myReviews.map((review) => {
                          const court = courts.find((item) => item.id === review.court_id);
                          return (
                            <article className="my-review-card" key={review.id} data-author-email={review.author_email}>
                              <div className="my-review-rating" aria-label={`Rating ${review.rating} out of 5`}>
                                <strong>{review.rating}</strong>
                                <span>★</span>
                              </div>
                              <div className="my-review-body">
                                <h3>{court?.name || review.court_id}</h3>
                                <p>{review.comment}</p>
                                <span className="muted-pill">{displayLongDate(review.created_at)}</span>
                              </div>
                              <button className="secondary-button compact" type="button" onClick={() => selectCourt(review.court_id)}>
                                До корту
                              </button>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  ) : null}

                  {cabinetTab === "settings" ? (
                    <section className="profile-panel">
                      <div className="profile-panel-head">
                        <div>
                          <span className="eyebrow dark">Налаштування</span>
                          <h2>Акаунт</h2>
                        </div>
                      </div>
                      <div className="settings-grid">
                        <article className="settings-card">
                          <h3>Дані профілю</h3>
                          <p>Зміни ім'я, телефон чи перевір контактний email у блоці зліва.</p>
                          {!isEditingProfile ? (
                            <button className="primary-button compact" type="button" onClick={startEditProfile}>
                              Редагувати дані
                            </button>
                          ) : (
                            <span className="muted-pill">Зараз редагується</span>
                          )}
                        </article>
                        <article className="settings-card">
                          <h3>Вийти з акаунту</h3>
                          <p>Завершити поточну сесію у браузері. Дані залишаться на сервері.</p>
                          <button className="secondary-button compact" type="button" onClick={logout}>
                            Вийти
                          </button>
                        </article>
                        <article className="settings-card">
                          <h3>Двофакторна автентифікація (MFA)</h3>
                          <p>
                            Статус: <strong>{profile?.mfa_enabled ? "увімкнено" : "вимкнено"}</strong>. Для admin та superuser MFA
                            завжди обов'язкова.
                          </p>
                          <button className="primary-button compact" type="button" onClick={toggleMfaPreference}>
                            {profile?.mfa_enabled ? "Вимкнути MFA" : "Увімкнути MFA"}
                          </button>
                        </article>
                        <article className={`settings-card danger-card gdpr-card ${myDataDeletionRequest ? "is-pending" : ""}`}>
                          <h3>Видалити персональні дані</h3>
                          {myDataDeletionRequest ? (
                            <>
                              <p>
                                Запит активний. Згідно GDPR Art. 17, адміністратори мають 14 днів, щоб його обробити. Якщо
                                ніхто не відреагує — акаунт буде автоматично видалено.
                              </p>
                              <div className="gdpr-status-block">
                                {(() => {
                                  const secs = secondsUntil(myDataDeletionRequest.deadline_at, nowTick);
                                  return (
                                    <span className={`status-badge ${deletionUrgencyTone(secs)}`}>
                                      {secs > 0 ? `Залишилось ${formatCountdown(secs)}` : "Час вийшов"}
                                    </span>
                                  );
                                })()}
                                <dl className="gdpr-status-meta">
                                  <div>
                                    <dt>Подано</dt>
                                    <dd>{displayLongDate(myDataDeletionRequest.requested_at)}</dd>
                                  </div>
                                  <div>
                                    <dt>Дедлайн</dt>
                                    <dd>{displayLongDate(myDataDeletionRequest.deadline_at)}</dd>
                                  </div>
                                </dl>
                              </div>
                              <button className="secondary-button compact" type="button" onClick={withdrawDataDeletion}>
                                Відкликати запит
                              </button>
                            </>
                          ) : (
                            <>
                              <p>Запит надсилається адміністраторам. Згідно GDPR обробка триває до 14 днів — після цього акаунт автоматично видалиться.</p>
                              <button className="danger-button compact" type="button" onClick={requestDataDeletion}>
                                Надіслати запит
                              </button>
                            </>
                          )}
                        </article>
                      </div>
                    </section>
                  ) : null}
                </main>
              </div>

              {selectedBooking ? (
                <div className="booking-drawer-backdrop" onClick={closeBookingDetail}>
                  <aside
                    className="booking-drawer"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="booking-drawer-title"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <header className="booking-drawer-header">
                      <div>
                        <span className="eyebrow dark">Бронювання</span>
                        <h2 id="booking-drawer-title">{selectedBooking.court_name || selectedBooking.court_id}</h2>
                        <p>
                          {selectedBooking.court_address}
                          {selectedBooking.court_city ? ` · ${selectedBooking.court_city}` : ""}
                          {selectedBooking.court_district ? `, ${selectedBooking.court_district}` : ""}
                        </p>
                      </div>
                      <button className="icon-close" type="button" aria-label="Закрити" onClick={closeBookingDetail}>
                        ×
                      </button>
                    </header>

                    <div
                      className="booking-drawer-image"
                      style={
                        selectedBooking.court_image_url
                          ? {
                              backgroundImage: `url(${
                                selectedBooking.court_image_url.startsWith("http")
                                  ? selectedBooking.court_image_url
                                  : `${API_ORIGIN}${selectedBooking.court_image_url}`
                              })`
                            }
                          : { background: courtVisuals[0] }
                      }
                    >
                      <span className={`status-badge ${bookingStatusInfo(selectedBooking).tone}`}>
                        {bookingStatusInfo(selectedBooking).label}
                      </span>
                    </div>

                    <div className="booking-drawer-facts">
                      <div>
                        <span>Дата</span>
                        <strong>{displayLongDate(selectedBooking.starts_at)}</strong>
                      </div>
                      <div>
                        <span>Час</span>
                        <strong>{displayTime(selectedBooking.starts_at)} – {displayTime(selectedBooking.ends_at)}</strong>
                      </div>
                      <div>
                        <span>Тривалість</span>
                        <strong>{bookingDurationMinutes(selectedBooking.starts_at, selectedBooking.ends_at)} хв</strong>
                      </div>
                      <div>
                        <span>Покриття</span>
                        <strong>{selectedBooking.court_surface || "—"}</strong>
                      </div>
                      <div>
                        <span>Сума</span>
                        <strong>{formatMoney(selectedBooking.total_price)}</strong>
                      </div>
                      {selectedBooking.created_at ? (
                        <div>
                          <span>Створено</span>
                          <strong>{displayLongDate(selectedBooking.created_at)}</strong>
                        </div>
                      ) : null}
                    </div>

                    {selectedBooking.status === "cancelled" && selectedBooking.canceled_reason ? (
                      <p className="cancel-reason large">Причина скасування: {selectedBooking.canceled_reason}</p>
                    ) : null}

                    <div className="booking-drawer-actions">
                      <button className="secondary-button compact" type="button" onClick={() => selectCourt(selectedBooking.court_id)}>
                        Перейти до корту
                      </button>
                      {isBookingCancellable(selectedBooking) ? (
                        <button
                          className="danger-button compact"
                          type="button"
                          onClick={() => cancelMyBooking(selectedBooking.id)}
                        >
                          Скасувати бронь
                        </button>
                      ) : null}
                    </div>

                    <div className="booking-drawer-section">
                      <h3>{selectedBooking.my_review ? "Твій відгук" : "Залиш відгук про корт"}</h3>
                      <form className="inline-form-card" onSubmit={submitCourtReview}>
                        <div className="rating-row">
                          {[1, 2, 3, 4, 5].map((star) => (
                            <button
                              key={star}
                              type="button"
                              className={`star-button ${Number(reviewRating) >= star ? "active" : ""}`}
                              onClick={() => setReviewRating(star)}
                              aria-label={`${star} stars`}
                            >
                              ★
                            </button>
                          ))}
                          <span className="rating-value">{reviewRating} / 5</span>
                        </div>
                        <textarea
                          value={reviewComment}
                          onChange={(event) => setReviewComment(event.target.value)}
                          placeholder="Що сподобалось або що треба покращити?"
                          required
                        />
                        <button className="primary-button compact" type="submit">
                          {selectedBooking.my_review ? "Оновити" : "Опублікувати"}
                        </button>
                      </form>
                    </div>

                    <div className="booking-drawer-section">
                      <h3>Написати модератору</h3>
                      <form className="inline-form-card" onSubmit={sendModeratorMessage}>
                        <textarea
                          value={moderatorMessage}
                          onChange={(event) => setModeratorMessage(event.target.value)}
                          placeholder="Питання щодо бронювання, корту або доступу..."
                          required
                        />
                        <button className="secondary-button compact" type="submit">
                          Відправити
                        </button>
                      </form>
                    </div>

                    {selectedBooking.reviews && selectedBooking.reviews.length > 0 ? (
                      <div className="booking-drawer-section">
                        <h3>Останні відгуки про корт</h3>
                        <div className="drawer-review-list">
                          {selectedBooking.reviews.map((review) => (
                            <article key={review.id} className={`drawer-review ${review.is_mine ? "is-mine" : ""}`} data-author-email={review.author_email}>
                              <header>
                                <strong>{review.rating} ★</strong>
                                <span>{displayLongDate(review.created_at)}</span>
                                {review.is_mine ? <span className="mine-pill">твій</span> : null}
                              </header>
                              <p>{review.comment}</p>
                            </article>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </aside>
                </div>
              ) : null}
            </section>
          )
        ) : null}

        {view === "admin" && isManager ? (
          <section className="content-section admin-section">
            <div className="section-heading inline">
              <div>
                <span className="eyebrow dark">Дашборд</span>
                <h2>Admin control center</h2>
              </div>
              <button className="primary-button" onClick={refreshAdminAndCourts} disabled={!isAuthed}>
                Оновити
              </button>
            </div>

            <div className="admin-grid">
              <article className="metric-card">
                <span>Users</span>
                <strong>{adminUsers.length}</strong>
                <p>Без PII.</p>
              </article>
              <article className="metric-card">
                <span>Roles</span>
                <strong>{roles.length}</strong>
                <p>Ролі.</p>
              </article>
              <article className="metric-card">
                <span>Permissions</span>
                <strong>{policies.length}</strong>
                <p>Endpoint rules.</p>
              </article>
              <article className="metric-card">
                <span>Bookings</span>
                <strong>{adminBookings.length}</strong>
                <p>Список броней.</p>
              </article>
              <article className="metric-card">
                <span>Courts</span>
                <strong>{courts.length}</strong>
                <p>Каталог.</p>
              </article>
            </div>

            <div className="admin-tabs">
              {[
                ...(profile?.role === "admin" || profile?.role === "superuser"
                  ? [
                      ["users", "Users"],
                      ["roles", "Roles"],
                      ["permissions", "Permissions"],
                      ["courts", "Courts"]
                    ]
                  : []),
                ["bookings", "Bookings"],
                ["moderator-messages", "Запити до модератора"],
                ...(profile?.role === "admin" || profile?.role === "superuser"
                  ? [["gdpr", `GDPR${dataDeletionRequests.filter((row) => row.status === "pending").length > 0 ? ` · ${dataDeletionRequests.filter((row) => row.status === "pending").length}` : ""}`]]
                  : [])
              ].map(([id, label]) => (
                <button key={id} className={adminTab === id ? "active" : ""} onClick={() => setAdminTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            {adminTab === "moderator-messages" ? (
              <div className="reviews-grid">
                {moderatorMessages.length === 0 ? <div className="empty-state">Поки немає запитів.</div> : null}
                {moderatorMessages.map((message) => (
                  <article className="review-card" key={message.id}>
                    <strong>{message.subject}</strong>
                    <span>{message.author_name} · {displayLongDate(message.created_at)}</span>
                    <ModeratorMessage message={message.message} />
                  </article>
                ))}
              </div>
            ) : null}

            {adminTab === "users" && (profile?.role === "admin" || profile?.role === "superuser") ? (
              <div className="admin-panel-grid courts-admin-layout">
                <form className="admin-form-card" onSubmit={createAdminUser}>
                  <h3>Create user</h3>
                  <input
                    value={newUser.email}
                    onChange={(event) => setNewUser((current) => ({ ...current, email: event.target.value }))}
                    placeholder="email@example.com"
                    type="email"
                  />
                  <input
                    value={newUser.full_name}
                    onChange={(event) => setNewUser((current) => ({ ...current, full_name: event.target.value }))}
                    placeholder="Full name"
                  />
                  <input
                    value={newUser.password}
                    onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))}
                    placeholder="Password"
                  />
                  <select value={newUser.role} onChange={(event) => setNewUser((current) => ({ ...current, role: event.target.value }))}>
                    {["user", "moderator", "admin", "superuser"].map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                  <button className="primary-button" type="submit">
                    Create user
                  </button>
                </form>
                <div className="admin-table-card">
                  <h3>All users</h3>
                  <div className="courts-admin-content">
                    <div className="courts-admin-list">
                      {adminUsers.map((user) => (
                        <button
                          className={selectedAdminUserId === user.id ? "court-admin-item active" : "court-admin-item"}
                          key={user.id}
                          type="button"
                          onClick={() => openUserEditor(user)}
                        >
                          <strong>Користувач #{user.id}</strong>
                          <span>{user.role} - {user.is_active ? "active" : "inactive"}</span>
                        </button>
                      ))}
                    </div>
                    {adminUserForm ? (
                      <form className="court-editor-panel" onSubmit={saveUserEditor}>
                        <h4>Edit user</h4>
                        <input value={"Hidden by privacy policy"} disabled readOnly />
                        <select
                          value={adminUserForm.role || "user"}
                          onChange={(event) => setAdminUserForm((current) => ({ ...current, role: event.target.value }))}
                        >
                          {["user", "moderator", "admin", "superuser"].map((role) => (
                            <option key={role}>{role}</option>
                          ))}
                        </select>
                        <label className="switch-cell">
                          <input
                            type="checkbox"
                            checked={Boolean(adminUserForm.is_active)}
                            onChange={(event) =>
                              setAdminUserForm((current) => ({ ...current, is_active: event.target.checked }))
                            }
                          />
                          <span>{adminUserForm.is_active ? "Active" : "Inactive"}</span>
                        </label>
                        <div className="row-actions">
                          <button className="primary-button" type="submit">Save changes</button>
                          {adminUserForm.role !== "superuser" && adminUserForm.id !== profile?.id ? (
                            <button className="danger-button" type="button" onClick={() => deleteAdminUser(adminUserForm.id)}>
                              Delete user
                            </button>
                          ) : (
                            <span className="muted-pill">
                              {adminUserForm.id === profile?.id ? "Власний акаунт" : "Системний акаунт"}
                            </span>
                          )}
                        </div>
                      </form>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {adminTab === "roles" && (profile?.role === "admin" || profile?.role === "superuser") ? (
              <div className="admin-panel-grid">
                <form className="admin-form-card" onSubmit={createRole}>
                  <h3>Create role</h3>
                  <input value={newRole} onChange={(event) => setNewRole(event.target.value)} placeholder="role_name" />
                  <button className="primary-button" type="submit">
                    Create role
                  </button>
                </form>
                <div className="admin-table-card">
                  <h3>All roles</h3>
                  <div className="pill-list">
                    {roles.map((role) => (
                      <span className="admin-pill" key={role.id}>
                        {role.name}
                        <button type="button" onClick={() => deleteRole(role.id)}>x</button>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {adminTab === "permissions" && (profile?.role === "admin" || profile?.role === "superuser") ? (
              <div className="permissions-layout">
                {endpointPermissionCatalog.map((entry) => (
                  <article className="permissions-role-card" key={entry.endpoint}>
                    <button
                      className="permissions-endpoint-trigger"
                      type="button"
                      onClick={() => setExpandedEndpoint((current) => (current === entry.endpoint ? "" : entry.endpoint))}
                    >
                      <strong>{entry.endpoint}</strong>
                      <span>{expandedEndpoint === entry.endpoint ? "Hide methods" : "Show methods"}</span>
                    </button>
                    {expandedEndpoint === entry.endpoint ? (
                      <div className="permissions-method-list">
                        {entry.methods.map((method) => {
                          const methodKey = `${entry.endpoint}::${method}`;
                          return (
                            <div className="permissions-method-card" key={methodKey}>
                              <button
                                className="permissions-method-trigger"
                                type="button"
                                onClick={() => setExpandedMethodKey((current) => (current === methodKey ? "" : methodKey))}
                              >
                                <strong>{method.toUpperCase()}</strong>
                                <span>{expandedMethodKey === methodKey ? "Hide roles" : "Edit roles"}</span>
                              </button>
                              {expandedMethodKey === methodKey ? (
                                <>
                                  <div className="permissions-table">
                                    <div className="permissions-row header-row">
                                      <span>Role</span>
                                      <span>Effect</span>
                                      <span>Ownership</span>
                                      <span>State</span>
                                    </div>
                                    {allRoleNames.map((roleName) => {
                                      const key = permissionKey(entry.endpoint, method);
                                      const draft = permissionDrafts[roleName]?.[key] || { allowed: false, ownership: "all" };
                                      return (
                                        <div className="permissions-row" key={`${methodKey}-${roleName}`}>
                                          <strong>{roleName}</strong>
                                          <select
                                            value={draft.allowed ? "allow" : "deny"}
                                            onChange={(event) =>
                                              updatePermissionDraft(roleName, entry.endpoint, method, {
                                                allowed: event.target.value === "allow"
                                              })
                                            }
                                          >
                                            <option value="allow">allow</option>
                                            <option value="deny">deny</option>
                                          </select>
                                          <select
                                            value={draft.ownership}
                                            disabled={!draft.allowed}
                                            onChange={(event) =>
                                              updatePermissionDraft(roleName, entry.endpoint, method, { ownership: event.target.value })
                                            }
                                          >
                                            <option value="all">all</option>
                                            <option value="self">self</option>
                                          </select>
                                          <span>{draft.allowed ? "enabled" : "blocked"}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  <button className="primary-button" type="button" onClick={() => saveMethodPermissions(entry.endpoint, method)}>
                                    Save method rules
                                  </button>
                                </>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}

            {adminTab === "courts" && (profile?.role === "admin" || profile?.role === "superuser") ? (
              <div className="admin-panel-grid courts-admin-layout">
                <form className="admin-form-card" onSubmit={createCourt}>
                  <h3>Create court</h3>
                  <input value={newCourt.name} onChange={(event) => setNewCourt((current) => ({ ...current, name: event.target.value }))} placeholder="Court name" />
                  <input value={newCourt.city} onChange={(event) => setNewCourt((current) => ({ ...current, city: event.target.value }))} placeholder="City" />
                  <input
                    value={newCourt.district}
                    onChange={(event) => setNewCourt((current) => ({ ...current, district: event.target.value }))}
                    placeholder="District"
                  />
                  <input
                    value={newCourt.address}
                    onChange={(event) => setNewCourt((current) => ({ ...current, address: event.target.value }))}
                    placeholder="Address"
                  />
                  <input
                    value={newCourt.image_url}
                    onChange={(event) => setNewCourt((current) => ({ ...current, image_url: event.target.value }))}
                    placeholder="Image URL"
                  />
                  <select value={newCourt.surface} onChange={(event) => setNewCourt((current) => ({ ...current, surface: event.target.value }))}>
                    <option>Hard</option>
                    <option>Clay</option>
                    <option>Grass</option>
                  </select>
                  <div className="auth-two-columns">
                    <input
                      value={newCourt.opening_time}
                      onChange={(event) => setNewCourt((current) => ({ ...current, opening_time: event.target.value }))}
                      type="time"
                    />
                    <input
                      value={newCourt.closing_time}
                      onChange={(event) => setNewCourt((current) => ({ ...current, closing_time: event.target.value }))}
                      type="time"
                    />
                  </div>
                  <input
                    value={newCourt.price_per_hour}
                    onChange={(event) => setNewCourt((current) => ({ ...current, price_per_hour: event.target.value }))}
                    placeholder="Price per hour"
                    type="number"
                  />
                  <button className="primary-button" type="submit">
                    Create court
                  </button>
                </form>
                <div className="admin-table-card">
                  <h3>All courts</h3>
                  <div className="courts-admin-content">
                    <div className="courts-admin-list">
                      {courts.map((court) => (
                        <button
                          className={selectedAdminCourtId === court.id ? "court-admin-item active" : "court-admin-item"}
                          key={court.id}
                          type="button"
                          onClick={() => openCourtEditor(court)}
                        >
                          <strong>{court.name}</strong>
                          <span>{court.city} - {court.district}</span>
                        </button>
                      ))}
                    </div>
                    {adminCourtForm ? (
                      <form className="court-editor-panel" onSubmit={saveCourtEditor}>
                        <h4>Edit court</h4>
                        <input value={adminCourtForm.name || ""} onChange={(event) => setAdminCourtForm((current) => ({ ...current, name: event.target.value }))} />
                        <input value={adminCourtForm.city || ""} onChange={(event) => setAdminCourtForm((current) => ({ ...current, city: event.target.value }))} />
                        <input value={adminCourtForm.district || ""} onChange={(event) => setAdminCourtForm((current) => ({ ...current, district: event.target.value }))} />
                        <input value={adminCourtForm.address || ""} onChange={(event) => setAdminCourtForm((current) => ({ ...current, address: event.target.value }))} />
                        <select value={adminCourtForm.surface || "Hard"} onChange={(event) => setAdminCourtForm((current) => ({ ...current, surface: event.target.value }))}>
                          <option>Hard</option>
                          <option>Clay</option>
                          <option>Grass</option>
                        </select>
                        <div className="auth-two-columns">
                          <input type="time" value={adminCourtForm.opening_time || "07:00"} onChange={(event) => setAdminCourtForm((current) => ({ ...current, opening_time: event.target.value }))} />
                          <input type="time" value={adminCourtForm.closing_time || "22:00"} onChange={(event) => setAdminCourtForm((current) => ({ ...current, closing_time: event.target.value }))} />
                        </div>
                        <input type="number" value={adminCourtForm.price_per_hour || 0} onChange={(event) => setAdminCourtForm((current) => ({ ...current, price_per_hour: event.target.value }))} />
                        <input
                          value={adminCourtForm.image_url || ""}
                          onChange={(event) => setAdminCourtForm((current) => ({ ...current, image_url: event.target.value }))}
                          placeholder="Image URL"
                        />
                        <label className="court-image-upload">
                          <span>Upload image file</span>
                          <input type="file" accept="image/*" onChange={(event) => uploadCourtImageFile(adminCourtForm.id, event.target.files?.[0])} />
                        </label>
                        {resolveCourtImageUrl(adminCourtForm) ? <img src={resolveCourtImageUrl(adminCourtForm)} alt="Court" className="court-editor-preview" /> : null}
                        <div className="row-actions">
                          <button className="primary-button" type="submit">Save changes</button>
                          <button className="danger-button" type="button" onClick={() => deleteCourt(adminCourtForm.id)}>Delete court</button>
                        </div>
                      </form>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {adminTab === "bookings" ? (
              <div className="admin-table-card">
                <h3>All bookings</h3>
                <div className="admin-table bookings-table">
                  <div className="admin-row header-row">
                    <span>ID</span>
                    <span>User</span>
                    <span>Court</span>
                    <span>Status</span>
                    <span>Date & time</span>
                    <span>До старту</span>
                    <span>Total</span>
                    <span>Reminder</span>
                  </div>
                  {adminBookings.map((booking) => (
                    <div className="admin-row" key={booking.id}>
                      <span>{booking.id.slice(0, 8)}</span>
                      <span>Hidden</span>
                      <span>{booking.court_name || booking.court_id.slice(0, 8)}</span>
                      <strong>{booking.status}</strong>
                      <span>{formatBookingRange(booking.starts_at, booking.ends_at)}</span>
                      <span>
                        {secondsUntil(booking.starts_at, nowTick) > 0
                          ? formatCountdown(secondsUntil(booking.starts_at, nowTick))
                          : "Вже почалось/минуло"}
                      </span>
                      <span>{formatMoney(booking.total_price)}</span>
                      <div className="row-actions">
                        <input
                          value={bookingRemindComments[booking.id] || ""}
                          onChange={(event) =>
                            setBookingRemindComments((current) => ({ ...current, [booking.id]: event.target.value }))
                          }
                          placeholder="Коментар (опційно)"
                        />
                        <button className="secondary-button compact" type="button" onClick={() => remindBooking(booking.id)}>
                          Remind
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {adminTab === "gdpr" && (profile?.role === "admin" || profile?.role === "superuser") ? (
              <div className="gdpr-panel">
                <div className="gdpr-panel-head">
                  <div>
                    <h3>GDPR — запити на видалення</h3>
                    <p>
                      Згідно Art. 17 GDPR ми маємо <strong>14 днів</strong>, щоб обробити запит. Якщо не апрувнути або не відхилити — система видалить акаунт автоматично.
                    </p>
                  </div>
                  <div className="filter-row tight">
                    {[
                      ["pending", "Активні"],
                      ["approved_executed", "Виконані"],
                      ["cancelled", "Відхилені"],
                      ["expired_executed", "Прострочені"],
                      ["all", "Усі"]
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className={dataDeletionFilter === id ? "chip active" : "chip"}
                        onClick={() => setDataDeletionFilter(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="gdpr-grid">
                  {dataDeletionRequests.length === 0 ? (
                    <div className="empty-state large">
                      <strong>Запитів немає.</strong>
                      <span>Коли користувач подасть запит — він з'явиться тут із відліком.</span>
                    </div>
                  ) : null}
                  {dataDeletionRequests.map((row) => {
                    const secs = secondsUntil(row.deadline_at, nowTick);
                    const isPending = row.status === "pending";
                    const tone = isPending ? deletionUrgencyTone(secs) : row.status === "approved_executed" || row.status === "expired_executed" ? "danger" : "muted";
                    return (
                      <article className={`gdpr-card-admin ${tone}`} key={row.id}>
                        <header>
                          <div>
                            <strong>Запит #{row.id}</strong>
                            <span>Користувач прихований</span>
                          </div>
                          <span className={`status-badge ${tone}`}>
                            {isPending
                              ? secs > 0
                                ? formatCountdown(secs)
                                : "Час вийшов"
                              : row.status === "approved_executed"
                                ? "Видалено вручну"
                                : row.status === "expired_executed"
                                  ? "Авто-видалено"
                                  : "Відхилено"}
                          </span>
                        </header>
                        {isPending ? (
                          <div className="gdpr-progress" aria-hidden="true">
                            <div
                              className={`gdpr-progress-bar ${tone}`}
                              style={{
                                width: `${Math.min(100, Math.max(0, ((row.deadline_days_total * 86400 - secs) / (row.deadline_days_total * 86400)) * 100))}%`
                              }}
                            />
                          </div>
                        ) : null}
                        <dl className="gdpr-card-facts">
                          <div>
                            <dt>Подано</dt>
                            <dd>{displayLongDate(row.requested_at)}</dd>
                          </div>
                          <div>
                            <dt>Дедлайн</dt>
                            <dd>{displayLongDate(row.deadline_at)}</dd>
                          </div>
                          {row.processed_at ? (
                            <div>
                              <dt>Оброблено</dt>
                              <dd>{displayLongDate(row.processed_at)}</dd>
                            </div>
                          ) : null}
                          {row.reason ? (
                            <div className="full-row">
                              <dt>Причина</dt>
                              <dd>{row.reason}</dd>
                            </div>
                          ) : null}
                          {row.processed_note ? (
                            <div className="full-row">
                              <dt>Нотатка адміна</dt>
                              <dd>{row.processed_note}</dd>
                            </div>
                          ) : null}
                        </dl>
                        {isPending ? (
                          <div className="row-actions">
                            <button className="danger-button compact" type="button" onClick={() => approveDataDeletion(row.id)}>
                              Видалити зараз
                            </button>
                            <button className="secondary-button compact" type="button" onClick={() => rejectDataDeletion(row.id)}>
                              Відхилити
                            </button>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="ops-panel">
              <button className="secondary-button" onClick={triggerNotification} disabled={!isAuthed}>
                Email кампанія
              </button>
              <button className="secondary-button" onClick={triggerReplay} disabled={!isAuthed}>
                Replay event log
              </button>
            </div>
          </section>
        ) : null}
      </main>
      {error ? (
        <div className="toast error-toast" role="alert">
          <span>⚠</span>
          <span>{error}</span>
          <button type="button" aria-label="Закрити" onClick={() => setError("")}>×</button>
        </div>
      ) : null}
      {success ? (
        <div className="toast success-toast" role="status">
          <span>✓</span>
          <span>{success}</span>
          <button type="button" aria-label="Закрити" onClick={() => setSuccess("")}>×</button>
        </div>
      ) : null}
      {confirmDialog ? (
        <div className="confirm-backdrop" onClick={() => closeConfirmDialog(false)}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="confirm-title">{confirmDialog.title}</h3>
            <p>{confirmDialog.message}</p>
            <div className="confirm-actions">
              <button className="secondary-button" type="button" onClick={() => closeConfirmDialog(false)}>
                {confirmDialog.cancelLabel}
              </button>
              <button
                className={confirmDialog.tone === "danger" ? "danger-button" : "primary-button"}
                type="button"
                onClick={() => closeConfirmDialog(true)}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
