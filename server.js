const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const REVIEWS_FILE = path.join(DATA_DIR, 'call-reviews.json');

// ─── Ensure data directory exists ───
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Simple UUID generator ───
function generateUUID() {
  return crypto.randomBytes(16).toString('hex').replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    '$1-$2-$3-$4-$5'
  );
}

// ─── Read reviews from file ───
function readReviews() {
  try {
    if (!fs.existsSync(REVIEWS_FILE)) return [];
    const data = fs.readFileSync(REVIEWS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Error reading reviews:', e.message);
    return [];
  }
}

// ─── Save reviews to file ───
function saveReviews(reviews) {
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
}

// ─── Verify Fathom webhook signature ───
function verifyFathomSignature(webhookId, webhookTimestamp, webhookSignature, rawBody) {
  const secret = process.env.FATHOM_WEBHOOK_SECRET || '';
  if (!secret) {
    console.warn('FATHOM_WEBHOOK_SECRET not set — skipping verification');
    return true;
  }

  // Extract base64 key after "whsec_"
  const base64Key = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBytes = Buffer.from(base64Key, 'base64');

  // Signed content: webhookId.webhookTimestamp.rawBody
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;

  // Compute HMAC-SHA256
  const computed = crypto.createHmac('sha256', keyBytes)
    .update(signedContent)
    .digest('base64');

  // Compare against each signature in the header (space-delimited, prefixed with "v1,")
  const signatures = webhookSignature.split(' ');
  for (const sig of signatures) {
    const value = sig.startsWith('v1,') ? sig.slice(3) : sig;
    if (crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(value))) {
      return true;
    }
  }
  return false;
}

// ─── Make HTTPS request helper ───
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Call Claude API for review ───
async function reviewCallWithClaude(transcript, meetingTitle) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  // Format transcript as readable text
  const transcriptText = Array.isArray(transcript)
    ? transcript.map(t => `[${t.speaker}]: ${t.text}`).join('\n')
    : String(transcript);

  const systemPrompt = `You are an elite sales coach reviewing a sales call transcript. Score and analyse the call across these dimensions. Be specific, direct, and commercially minded. Reference exact moments from the transcript.`;

  const userPrompt = `Here is the sales call transcript for "${meetingTitle}":\n\n${transcriptText}\n\nPlease review this call and respond with ONLY a valid JSON object (no markdown, no explanation) with exactly this structure:\n{\n  "overall_score": <number 1-10>,\n  "summary": "<one paragraph summary>",\n  "what_went_well": ["<point 1>", "<point 2>", "<point 3>"],\n  "what_to_improve": ["<improvement 1>", "<improvement 2>"],\n  "missed_opportunities": ["<opportunity 1>"],\n  "talk_listen_ratio": "<e.g. 60/40>",\n  "buying_signals": ["<signal noted>"],\n  "objections_handled": ["<objection and how it was handled>"],\n  "next_steps_clarity": "<Clear or Unclear or Not set>",\n  "recommendation": "<Close or Nurture or Disqualify>",\n  "coaching_focus": "<the single most important thing to work on for the next call>"\n}`;

  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const result = await httpsRequest({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(requestBody)
    }
  }, requestBody);

  if (result.status !== 200) {
    throw new Error(`Claude API error ${result.status}: ${JSON.stringify(result.body)}`);
  }

  const content = result.body.content?.[0]?.text || '';
  // Extract JSON from response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Claude response: ' + content.substring(0, 200));
  }
  return JSON.parse(jsonMatch[0]);
}

// ─── Fetch Fathom meetings ───
async function fetchFathomMeetings() {
  const apiKey = process.env.FATHOM_API_KEY;
  if (!apiKey) throw new Error('FATHOM_API_KEY not set');

  const result = await httpsRequest({
    hostname: 'api.fathom.ai',
    path: '/external/v1/meetings?include_transcript=true',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  }, null);

  return result.body;
}

// ─── Read raw request body ───
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;

  // CORS headers for API routes
  if (url.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // ── POST /api/fathom/webhook ──
  if (method === 'POST' && url === '/api/fathom/webhook') {
    try {
      const rawBody = await readBody(req);

      // Verify signature
      const webhookId = req.headers['webhook-id'] || '';
      const webhookTimestamp = req.headers['webhook-timestamp'] || '';
      const webhookSignature = req.headers['webhook-signature'] || '';

      if (webhookId && webhookTimestamp && webhookSignature) {
        const valid = verifyFathomSignature(webhookId, webhookTimestamp, webhookSignature, rawBody);
        if (!valid) {
          console.error('Webhook signature verification failed');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }
      }

      const payload = JSON.parse(rawBody);

      // Only process new_meeting_content_ready events
      if (payload.event_type !== 'new_meeting_content_ready') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, skipped: true }));
        return;
      }

      const meeting = payload.meeting || {};
      const recording = payload.recording || {};
      const transcript = recording.transcript || [];

      console.log(`Processing webhook for meeting: ${meeting.title || meeting.id}`);

      // Run AI review
      let review;
      try {
        review = await reviewCallWithClaude(transcript, meeting.title || 'Sales Call');
      } catch (e) {
        console.error('Claude review failed:', e.message);
        review = {
          overall_score: 0,
          summary: 'AI review failed: ' + e.message,
          what_went_well: [],
          what_to_improve: [],
          missed_opportunities: [],
          talk_listen_ratio: 'Unknown',
          buying_signals: [],
          objections_handled: [],
          next_steps_clarity: 'Not set',
          recommendation: 'Nurture',
          coaching_focus: 'Review failed — check API key'
        };
      }

      // Build review record
      const reviewRecord = {
        id: generateUUID(),
        meeting_id: meeting.id || generateUUID(),
        title: meeting.title || 'Sales Call',
        date: meeting.started_at || new Date().toISOString(),
        duration_seconds: meeting.duration_seconds || 0,
        attendees: meeting.attendees || [],
        review,
        raw_summary: recording.summary || '',
        action_items: recording.action_items || [],
        reviewed_at: new Date().toISOString()
      };

      // Append to reviews file
      const reviews = readReviews();
      reviews.unshift(reviewRecord); // newest first
      saveReviews(reviews);

      console.log(`Review saved for meeting: ${reviewRecord.title} (id: ${reviewRecord.id})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: reviewRecord.id }));

    } catch (e) {
      console.error('Webhook error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/call-reviews ──
  if (method === 'GET' && url === '/api/call-reviews') {
    try {
      const reviews = readReviews();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reviews));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/fathom/calls ──
  if (method === 'GET' && url === '/api/fathom/calls') {
    try {
      const data = await fetchFathomMeetings();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error('Fathom API error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Serve index.html for all other requests ──
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Error loading page');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Mission Control running on port ${PORT}`);
});
