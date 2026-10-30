const MAX_REQUEST_BYTES = 4096;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function validateRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Invalid request data.";
  }

  const fields = [
    ["name", 120],
    ["organization", 160],
    ["email", 254],
    ["purpose", 2000]
  ];

  for (const [field, maxLength] of fields) {
    const value = data[field];

    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > maxLength
    ) {
      return `Invalid ${field}.`;
    }
  }

  const email = data.email.trim();

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[\r\n]/.test(email)
  ) {
    return "Invalid email address.";
  }

  return null;
}

async function notifyEvaluationRequest(env, requestId) {
  if (!env.RESEND_API_KEY || !env.EVALUATION_NOTIFY_EMAIL) {
    throw new Error("Email configuration missing.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "SOLO GHOST <evaluations@sologhost.tech>",
      to: [env.EVALUATION_NOTIFY_EMAIL],
      subject: "SG-RVA01 — New evaluation request",
      text:
        "A new SG-RVA01 evaluation request has been received.\n\n" +
        "Request ID: " + requestId + "\n\n" +
        "Status: Pending review.\n\n" +
        "Review the request through the authorized administration workflow."
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error("Email notification failed.");
  }
}

async function saveEvaluationRequest(db, data) {
  const id = crypto.randomUUID();

  await db.prepare(`
    INSERT INTO evaluation_requests
      (id, name, organization, email, purpose, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).bind(
    id,
    data.name.trim(),
    data.organization.trim(),
    data.email.trim(),
    data.purpose.trim()
  ).run();

  return id;
}

async function verifyTurnstile(token, secretKey, remoteIP) {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 2048 ||
    !secretKey
  ) {
    return false;
  }

  const formData = new FormData();

  formData.append("secret", secretKey);
  formData.append("response", token);

  if (remoteIP) {
    formData.append("remoteip", remoteIP);
  }

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!response.ok) {
      return false;
    }

    const result = await response.json();

    return result.success === true;
  } catch {
    return false;
  }
}

async function verifyAdminToken(request, env) {
  const expectedToken = env.ADMIN_API_TOKEN;

  if (
    typeof expectedToken !== "string" ||
    expectedToken.length < 32
  ) {
    return false;
  }

  const authorization = request.headers.get("Authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const providedToken = authorization.slice(7);

  if (
    providedToken.length !== expectedToken.length ||
    providedToken.length > 512
  ) {
    return false;
  }

  const encoder = new TextEncoder();

  const providedBytes = encoder.encode(providedToken);
  const expectedBytes = encoder.encode(expectedToken);

  if (providedBytes.length !== expectedBytes.length) {
    return false;
  }

  const providedHash = await crypto.subtle.digest(
    "SHA-256",
    providedBytes
  );

  const expectedHash = await crypto.subtle.digest(
    "SHA-256",
    expectedBytes
  );

  const a = new Uint8Array(providedHash);
  const b = new Uint8Array(expectedHash);

  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a[i] ^ b[i];
  }

  return difference === 0;
}

export default {
  async fetch(request, env) {
  const url = new URL(request.url);

  // Administrative review API
  if (url.pathname === "/api/admin/evaluation-review") {

    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed." }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        }
      );
    }

    const authorized = await verifyAdminToken(request, env);

    if (!authorized) {
      return new Response(
        JSON.stringify({ error: "Unauthorized." }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        }
      );
    }

    const contentType = request.headers.get("Content-Type") || "";

    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return jsonResponse(
        { error: "Content-Type must be application/json." },
        415
      );
    }

    let review;

    try {
      const body = await request.text();

      if (new TextEncoder().encode(body).length > 4096) {
        return jsonResponse(
          { error: "Request too large." },
          413
        );
      }

      review = JSON.parse(body);

    } catch {
      return jsonResponse(
        { error: "Invalid JSON." },
        400
      );
    }

    if (
      !review ||
      typeof review !== "object" ||
      Array.isArray(review) ||
      typeof review.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(review.requestId) ||
      !["approved", "rejected"].includes(review.action) ||
      (review.reason !== undefined &&
        (typeof review.reason !== "string" ||
         review.reason.length > 1000))
    ) {
      return jsonResponse(
        { error: "Invalid review request." },
        400
      );
    }

    if (!env.DB) {
      return jsonResponse({ error: "Database unavailable." }, 503);
    }

    const requestId = review.requestId.toLowerCase();
    const action = review.action;
    const reason = (review.reason || "").trim() || null;
    const auditId = crypto.randomUUID();

    try {
      // D1 batch runs the statements together as a transaction.
      // SQLite changes() is 1 only when the preceding UPDATE won the
      // pending -> reviewed transition. Otherwise no audit row is inserted.
      const results = await env.DB.batch([
        env.DB.prepare(`
          UPDATE evaluation_requests
          SET status = ?, reviewed_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'
        `).bind(action, requestId),
        env.DB.prepare(`
          INSERT INTO evaluation_review_audit
            (id, request_id, action, reviewer, reason)
          SELECT ?, ?, ?, 'sgadmin', ?
          WHERE changes() = 1
        `).bind(auditId, requestId, action, reason)
      ]);

      const updated = results[0]?.meta?.changes;
      const audited = results[1]?.meta?.changes;

      if (updated === 1 && audited === 1) {
        return jsonResponse({ success: true, requestId, status: action }, 200);
      }
      if (updated === 0 && audited === 0) {
        // Do not distinguish nonexistent from already-reviewed IDs.
        return jsonResponse({ error: "Request is not pending or does not exist." }, 409);
      }

      // Unexpected result: do not report success. Investigate before release.
      console.error("Review transaction result mismatch.");
      return jsonResponse({ error: "Review outcome could not be verified." }, 500);
    } catch {
      console.error("Administrative review transaction failed.");
      return jsonResponse({ error: "Unable to complete review." }, 500);
    }

  }

  // Private administration API
  if (url.pathname === "/api/admin/evaluation-requests") {

    if (request.method !== "GET") {
      return jsonResponse(
        { error: "Method not allowed." },
        405
      );
    }

    // Authenticate before accessing customer information.
    const authorized = await verifyAdminToken(request, env);

    if (!authorized) {
      return jsonResponse(
        { error: "Unauthorized." },
        401
      );
    }

    if (!env.DB) {
      return jsonResponse(
        { error: "Database unavailable." },
        503
      );
    }

    try {
      const result = await env.DB.prepare(`
        SELECT
          id,
          name,
          organization,
          email,
          purpose,
          status,
          created_at,
          reviewed_at,
          access_expires_at
        FROM evaluation_requests
        ORDER BY created_at DESC
        LIMIT 100
      `).all();

      return new Response(
        JSON.stringify({
        success: true,
        requests: result.results
        }),
        {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Pragma": "no-cache"
        }
        }
      );

    } catch {
      console.error("Administrative database query failed.");

      return jsonResponse(
        { error: "Unable to retrieve evaluation requests." },
        500
      );
    }
  }

  if (url.pathname !== "/api/evaluation-request") {
    return env.ASSETS.fetch(request);
  }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const contentType = request.headers.get("Content-Type") || "";

    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return jsonResponse(
        { error: "Content-Type must be application/json." },
        415
      );
    }

    const declaredLength = Number(
      request.headers.get("Content-Length") || 0
    );

    if (declaredLength > MAX_REQUEST_BYTES) {
      return jsonResponse({ error: "Request too large." }, 413);
    }

    let data;

    try {
      const body = await request.text();

      if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
        return jsonResponse({ error: "Request too large." }, 413);
      }

      data = JSON.parse(body);
    } catch {
      return jsonResponse({ error: "Invalid JSON." }, 400);
    }

const validationError = validateRequest(data);

if (validationError) {
  return jsonResponse({ error: validationError }, 400);
}

const remoteIP = request.headers.get("CF-Connecting-IP");

const turnstileValid = await verifyTurnstile(
  data.turnstileToken,
  env.TURNSTILE_SECRET_KEY,
  remoteIP
);

if (!turnstileValid) {
  return jsonResponse(
    { error: "Security verification failed." },
    403
  );
}

if (!env.ENABLE_LOCAL_EVALUATION_TEST ||
    env.ENABLE_LOCAL_EVALUATION_TEST !== "true") {
  return jsonResponse(
    { error: "Evaluation submissions are not enabled yet." },
    503
  );
}

if (!env.DB) {
  return jsonResponse(
    { error: "Database unavailable." },
    503
  );
}

try {
  const requestId = await saveEvaluationRequest(env.DB, data);

  // Notification is best-effort.
  // A failed email must not invalidate a saved request.
  try {
    await notifyEvaluationRequest(env, requestId);
  } catch {
    console.error(
    "Evaluation notification failed for request:",
    requestId
    );
  }

  return jsonResponse(
    {
    success: true,
    requestId,
    message: "Evaluation request received."
    },
    201
  );
} catch {
  console.error("Evaluation request database operation failed.");

  return jsonResponse(
    { error: "Unable to save evaluation request." },
    500
  );
}
  }
};