export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000/api";
export const API_ORIGIN = API_BASE.endsWith("/api") ? API_BASE.slice(0, -4) : API_BASE;

let accessToken = "";
let expirationTimerId = null;
let onUnauthorizedHandler = null;

function decodeJwtPayload(token) {
  try {
    const segment = token.split(".")[1];
    if (!segment) {
      return null;
    }
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}



function tokenExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") {
    return null;
  }
  return payload.exp * 1000;
}

export function isTokenExpired(token) {
  if (!token) {
    return true;
  }
  const expMs = tokenExpiryMs(token);
  if (expMs === null) {
    return false;
  }
  return Date.now() >= expMs;
}

function clearExpirationTimer() {
  if (expirationTimerId !== null) {
    clearTimeout(expirationTimerId);
    expirationTimerId = null;
  }
}

function scheduleExpirationTimer(token) {
  clearExpirationTimer();
  if (!token) {
    return;
  }
  const expMs = tokenExpiryMs(token);
  if (expMs === null) {
    return;
  }
  const delay = expMs - Date.now();
  if (delay <= 0) {
    triggerUnauthorized("expired");
    return;
  }
  // setTimeout has 32-bit ms limit (~24.85 days); we never get that long so it's fine.
  expirationTimerId = setTimeout(() => triggerUnauthorized("expired"), delay);
}

function triggerUnauthorized(reason) {
  if (onUnauthorizedHandler) {
    try {
      onUnauthorizedHandler(reason);
    } catch {
      // ignore handler erro
    }
  }
}

export function setAccessToken(token) {
  accessToken = token || "";
  if (!accessToken) {
    clearExpirationTimer();
    return;
  }
  scheduleExpirationTimer(accessToken);
}

export function onUnauthorized(handler) {
  onUnauthorizedHandler = typeof handler === "function" ? handler : null;
}

async function request(path, options = {}) {
  const skipAuthHeader = options.headers && Object.prototype.hasOwnProperty.call(options.headers, "Authorization");

  if (accessToken && !skipAuthHeader && isTokenExpired(accessToken)) {
    triggerUnauthorized("expired");
    throw new Error("Сесія завершилась. Увійди заново.");
  }

  const isFormData = options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {})
  };
  if (accessToken && !skipAuthHeader) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  if (response.status === 401 && !skipAuthHeader) {
    triggerUnauthorized("rejected");
    const body = await response.text();
    throw new Error(body || "Сесія завершилась. Увійди заново.");
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(errorBody || `Request failed: ${response.status}`);
  }
  return response.json();
}

export const api = {
  health: () => request("/health", { headers: { Authorization: "" } }),
  login: (payload) => request("/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  verify2fa: (payload) => request("/auth/verify-2fa", { method: "POST", body: JSON.stringify(payload) }),
  verifyEmail: (payload) => request("/auth/verify-email", { method: "POST", body: JSON.stringify(payload) }),
  register: (payload) => request("/auth/register", { method: "POST", body: JSON.stringify(payload) }),
  listCourts: () => request("/courts", { headers: { Authorization: "" } }),
  getCourt: (courtId) => request(`/courts/${courtId}`, { headers: { Authorization: "" } }),
  createCourt: (payload) => request("/courts", { method: "POST", body: JSON.stringify(payload) }),
  updateCourt: (courtId, payload) => request(`/courts/${courtId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  uploadCourtImage: (courtId, file) => {
    const body = new FormData();
    body.append("file", file);
    return request(`/courts/${courtId}/image`, { method: "POST", body });
  },
  deleteCourt: (courtId) => request(`/courts/${courtId}`, { method: "DELETE" }),
  getAvailability: (courtId, start) =>
    request(`/courts/${courtId}/availability?start=${encodeURIComponent(start)}`, {
      headers: { Authorization: "" }
    }),
  listCourtBookings: (courtId) => request(`/courts/${courtId}/bookings`, { headers: { Authorization: "" } }),
  holdBooking: (payload) => request("/bookings/hold", { method: "POST", body: JSON.stringify(payload) }),
  confirmBooking: (payload) => request("/bookings/confirm", { method: "POST", body: JSON.stringify(payload) }),
  cancelBooking: (bookingId, payload) =>
    request(`/bookings/${bookingId}/cancel`, { method: "POST", body: JSON.stringify(payload) }),
  listMyBookings: () => request("/me/bookings"),
  getMyBooking: (bookingId) => request(`/me/bookings/${bookingId}`),
  getProfile: () => request("/me/profile"),
  updateProfile: (payload) => request("/me/profile", { method: "PATCH", body: JSON.stringify(payload) }),
  updateMfaPreference: (payload) => request("/me/profile/mfa", { method: "PATCH", body: JSON.stringify(payload) }),
  requestDataDeletion: (payload) =>
    request("/me/profile/request-data-deletion", { method: "POST", body: JSON.stringify(payload || {}) }),
  getDataDeletionStatus: () => request("/me/profile/data-deletion-status"),
  cancelDataDeletionRequest: () => request("/me/profile/data-deletion-request", { method: "DELETE" }),
  listFavorites: () => request("/me/favorites"),
  addFavorite: (payload) => request("/me/favorites", { method: "POST", body: JSON.stringify(payload) }),
  removeFavorite: (courtId) => request(`/me/favorites/${courtId}`, { method: "DELETE" }),
  createReview: (payload) => request("/me/reviews", { method: "POST", body: JSON.stringify(payload) }),
  listMyReviews: () => request("/me/reviews"),
  messageModerator: (payload) => request("/me/moderator-message", { method: "POST", body: JSON.stringify(payload) }),
  listPublicReviews: (courtId) => request(`/me/reviews/public/${courtId}`, { headers: { Authorization: "" } }),
  listAdminUsers: () => request("/admin/users"),
  createAdminUser: (payload) => request("/admin/users", { method: "POST", body: JSON.stringify(payload) }),
  updateAdminUser: (userId, payload) => request(`/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteAdminUser: (userId) => request(`/admin/users/${userId}`, { method: "DELETE" }),
  listRoles: () => request("/admin/roles"),
  createRole: (payload) => request("/admin/roles", { method: "POST", body: JSON.stringify(payload) }),
  deleteRole: (roleId) => request(`/admin/roles/${roleId}`, { method: "DELETE" }),
  listPolicies: () => request("/admin/policies"),
  createPolicy: (payload) => request("/admin/policies", { method: "POST", body: JSON.stringify(payload) }),
  updatePolicy: (policyId, payload) => request(`/admin/policies/${policyId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deletePolicy: (policyId) => request(`/admin/policies/${policyId}`, { method: "DELETE" }),
  listBookings: () => request("/admin/bookings"),
  sendNotification: (payload) =>
    request("/dashboard/notifications/email", { method: "POST", body: JSON.stringify(payload) }),
  listDashboardBookings: () => request("/dashboard/bookings"),
  remindBooking: (bookingId, payload) =>
    request(`/dashboard/bookings/${bookingId}/remind`, { method: "POST", body: JSON.stringify(payload || {}) }),
  replayEventLog: () => request("/admin/event-log/replay", { method: "POST", body: "{}" }),
  listDataDeletionRequests: (statusFilter = "pending") =>
    request(`/admin/data-deletion-requests?status_filter=${encodeURIComponent(statusFilter)}`),
  approveDataDeletionRequest: (requestId, payload) =>
    request(`/admin/data-deletion-requests/${requestId}/approve`, {
      method: "POST",
      body: JSON.stringify(payload || {})
    }),
  rejectDataDeletionRequest: (requestId, payload) =>
    request(`/admin/data-deletion-requests/${requestId}/reject`, {
      method: "POST",
      body: JSON.stringify(payload || {})
    })
};
