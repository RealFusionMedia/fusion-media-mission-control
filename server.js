     1|const http = require('http');
     2|const fs = require('fs');
     3|const path = require('path');
     4|const crypto = require('crypto');
     5|const https = require('https');
     6|
     7|const PORT = process.env.PORT || 3000;
     8|const DATA_DIR = path.join(__dirname, 'data');
     9|const REVIEWS_FILE = path.join(DATA_DIR, 'call-reviews.json');
    10|
    11|// ─── Ensure data directory exists ───
    12|if (!fs.existsSync(DATA_DIR)) {
    13|  fs.mkdirSync(DATA_DIR, { recursive: true });
    14|}
    15|
    16|// ─── Simple UUID generator ───
    17|function generateUUID() {
    18|  return crypto.randomBytes(16).toString('hex').replace(
    19|    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    20|    '$1-$2-$3-$4-$5'
    21|  );
    22|}
    23|
    24|// ─── Read reviews from file ───
    25|function readReviews() {
    26|  try {
    27|    if (!fs.existsSync(REVIEWS_FILE)) return [];
    28|    const data = fs.readFileSync(REVIEWS_FILE, 'utf8');
    29|    return JSON.parse(data);
    30|  } catch (e) {
    31|    console.error('Error reading reviews:', e.message);
    32|    return [];
    33|  }
    34|}
    35|
    36|// ─── Save reviews to file ───
    37|function saveReviews(reviews) {
    38|  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
    39|}
    40|
    41|// ─── Verify Fathom webhook signature ───
    42|function verifyFathomSignature(webhookId, webhookTimestamp, webhookSignature, rawBody) {
    43|  const secret=proces...CRET || '';
    44|  if (!secret) {
    45|    console.warn('FATHOM_PERSONAL_WEBHOOK_SECRET not set — skipping verification');
    46|    return true;
    47|  }
    48|
    49|  // Extract base64 key after "whsec_"
    50|  const base64Key = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    51|  const keyBytes = Buffer.from(base64Key, 'base64');
    52|
    53|  // Signed content: webhookId.webhookTimestamp.rawBody
    54|  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
    55|
    56|  // Compute HMAC-SHA256
    57|  const computed = crypto.createHmac('sha256', keyBytes)
    58|    .update(signedContent)
    59|    .digest('base64');
    60|
    61|  // Compare against each signature in the header (space-delimited, prefixed with "v1,")
    62|  const signatures = webhookSignature.split(' ');
    63|  for (const sig of signatures) {
    64|    const value = sig.startsWith('v1,') ? sig.slice(3) : sig;
    65|    if (crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(value))) {
    66|      return true;
    67|    }
    68|  }
    69|  return false;
    70|}
    71|
    72|// ─── Make HTTPS request helper ───
    73|function httpsRequest(options, body) {
    74|  return new Promise((resolve, reject) => {
    75|    const req = https.request(options, (res) => {
    76|      let data = '';
    77|      res.on('data', chunk => data += chunk);
    78|      res.on('end', () => {
    79|        try {
    80|          resolve({ status: res.statusCode, body: JSON.parse(data) });
    81|        } catch (e) {
    82|          resolve({ status: res.statusCode, body: data });
    83|        }
    84|      });
    85|    });
    86|    req.on('error', reject);
    87|    if (body) req.write(body);
    88|    req.end();
    89|  });
    90|}
    91|
    92|// ─── Call Claude API for review ───
    93|async function reviewCallWithClaude(transcript, meetingTitle) {
    94|  const apiKey=proces...KEY;
    95|  if (!apiKey) {
    96|    throw new Error('ANTHROPIC_API_KEY not set');
    97|  }
    98|
    99|  // Format transcript as readable text
   100|  const transcriptText = Array.isArray(transcript)
   101|    ? transcript.map(t => `[${t.speaker}]: ${t.text}`).join('\n')
   102|    : String(transcript);
   103|
   104|  const systemPrompt = `You are an elite sales coach reviewing a sales call transcript. Score and analyse the call across these dimensions. Be specific, direct, and commercially minded. Reference exact moments from the transcript.`;
   105|
   106|  const userPrompt = `Here is the sales call transcript for "${meetingTitle}":\n\n${transcriptText}\n\nPlease review this call and respond with ONLY a valid JSON object (no markdown, no explanation) with exactly this structure:\n{\n  "overall_score": <number 1-10>,\n  "summary": "<one paragraph summary>",\n  "what_went_well": ["<point 1>", "<point 2>", "<point 3>"],\n  "what_to_improve": ["<improvement 1>", "<improvement 2>"],\n  "missed_opportunities": ["<opportunity 1>"],\n  "talk_listen_ratio": "<e.g. 60/40>",\n  "buying_signals": ["<signal noted>"],\n  "objections_handled": ["<objection and how it was handled>"],\n  "next_steps_clarity": "<Clear or Unclear or Not set>",\n  "recommendation": "<Close or Nurture or Disqualify>",\n  "coaching_focus": "<the single most important thing to work on for the next call>"\n}`;
   107|
   108|  const requestBody = JSON.stringify({
   109|    model: 'claude-haiku-4-5',
   110|    max_tokens: 2048,
   111|    system: systemPrompt,
   112|    messages: [{ role: 'user', content: userPrompt }]
   113|  });
   114|
   115|  const result = await httpsRequest({
   116|    hostname: 'api.anthropic.com',
   117|    path: '/v1/messages',
   118|    method: 'POST',
   119|    headers: {
   120|      'x-api-key': apiKey,
   121|      'anthropic-version': '2023-06-01',
   122|      'content-type': 'application/json',
   123|      'content-length': Buffer.byteLength(requestBody)
   124|    }
   125|  }, requestBody);
   126|
   127|  if (result.status !== 200) {
   128|    throw new Error(`Claude API error ${result.status}: ${JSON.stringify(result.body)}`);
   129|  }
   130|
   131|  const content = result.body.content?.[0]?.text || '';
   132|  // Extract JSON from response
   133|  const jsonMatch = content.match(/\{[\s\S]*\}/);
   134|  if (!jsonMatch) {
   135|    throw new Error('No JSON found in Claude response: ' + content.substring(0, 200));
   136|  }
   137|  return JSON.parse(jsonMatch[0]);
   138|}
   139|
   140|// ─── Fetch Fathom meetings ───
   141|async function fetchFathomMeetings() {
   142|  const apiKey=proces...KEY;
   143|  if (!apiKey) throw new Error('FATHOM_PERSONAL_API_KEY not set');
   144|
   145|  const result = await httpsRequest({
   146|    hostname: 'api.fathom.ai',
   147|    path: '/external/v1/meetings?include_transcript=true',
   148|    method: 'GET',
   149|    headers: {
   150|      'Authorization': `Bearer ${apiKey}`,
   151|      'Content-Type': 'application/json'
   152|    }
   153|  }, null);
   154|
   155|  return result.body;
   156|}
   157|
   158|// ─── Read raw request body ───
   159|function readBody(req) {
   160|  return new Promise((resolve, reject) => {
   161|    let body = '';
   162|    req.on('data', chunk => body += chunk.toString());
   163|    req.on('end', () => resolve(body));
   164|    req.on('error', reject);
   165|  });
   166|}
   167|
   168|// ─── HTTP Server ───
   169|const server = http.createServer(async (req, res) => {
   170|  const url = req.url.split('?')[0];
   171|  const method = req.method;
   172|
   173|  // CORS headers for API routes
   174|  if (url.startsWith('/api/')) {
   175|    res.setHeader('Access-Control-Allow-Origin', '*');
   176|    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
   177|    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
   178|    if (method === 'OPTIONS') {
   179|      res.writeHead(204);
   180|      res.end();
   181|      return;
   182|    }
   183|  }
   184|
   185|  // ── POST /api/fathom/webhook ──
   186|  if (method === 'POST' && url === '/api/fathom/webhook') {
   187|    try {
   188|      const rawBody = await readBody(req);
   189|
   190|      // Verify signature
   191|      const webhookId = req.headers['webhook-id'] || '';
   192|      const webhookTimestamp = req.headers['webhook-timestamp'] || '';
   193|      const webhookSignature = req.headers['webhook-signature'] || '';
   194|
   195|      if (webhookId && webhookTimestamp && webhookSignature) {
   196|        const valid = verifyFathomSignature(webhookId, webhookTimestamp, webhookSignature, rawBody);
   197|        if (!valid) {
   198|          console.error('Webhook signature verification failed');
   199|          res.writeHead(401, { 'Content-Type': 'application/json' });
   200|          res.end(JSON.stringify({ error: 'Invalid signature' }));
   201|          return;
   202|        }
   203|      }
   204|
   205|      const payload = JSON.parse(rawBody);
   206|
   207|      // Only process new_meeting_content_ready events
   208|      if (payload.event_type !== 'new_meeting_content_ready') {
   209|        res.writeHead(200, { 'Content-Type': 'application/json' });
   210|        res.end(JSON.stringify({ ok: true, skipped: true }));
   211|        return;
   212|      }
   213|
   214|      const meeting = payload.meeting || {};
   215|      const recording = payload.recording || {};
   216|      const transcript = recording.transcript || [];
   217|
   218|      console.log(`Processing webhook for meeting: ${meeting.title || meeting.id}`);
   219|
   220|      // Run AI review
   221|      let review;
   222|      try {
   223|        review = await reviewCallWithClaude(transcript, meeting.title || 'Sales Call');
   224|      } catch (e) {
   225|        console.error('Claude review failed:', e.message);
   226|        review = {
   227|          overall_score: 0,
   228|          summary: 'AI review failed: ' + e.message,
   229|          what_went_well: [],
   230|          what_to_improve: [],
   231|          missed_opportunities: [],
   232|          talk_listen_ratio: 'Unknown',
   233|          buying_signals: [],
   234|          objections_handled: [],
   235|          next_steps_clarity: 'Not set',
   236|          recommendation: 'Nurture',
   237|          coaching_focus: 'Review failed — check API key'
   238|        };
   239|      }
   240|
   241|      // Build review record
   242|      const reviewRecord = {
   243|        id: generateUUID(),
   244|        meeting_id: meeting.id || generateUUID(),
   245|        title: meeting.title || 'Sales Call',
   246|        date: meeting.started_at || new Date().toISOString(),
   247|        duration_seconds: meeting.duration_seconds || 0,
   248|        attendees: meeting.attendees || [],
   249|        review,
   250|        raw_summary: recording.summary || '',
   251|        action_items: recording.action_items || [],
   252|        reviewed_at: new Date().toISOString()
   253|      };
   254|
   255|      // Append to reviews file
   256|      const reviews = readReviews();
   257|      reviews.unshift(reviewRecord); // newest first
   258|      saveReviews(reviews);
   259|
   260|      console.log(`Review saved for meeting: ${reviewRecord.title} (id: ${reviewRecord.id})`);
   261|
   262|      res.writeHead(200, { 'Content-Type': 'application/json' });
   263|      res.end(JSON.stringify({ ok: true, id: reviewRecord.id }));
   264|
   265|    } catch (e) {
   266|      console.error('Webhook error:', e.message);
   267|      res.writeHead(500, { 'Content-Type': 'application/json' });
   268|      res.end(JSON.stringify({ error: e.message }));
   269|    }
   270|    return;
   271|  }
   272|
   273|  // ── GET /api/call-reviews ──
   274|  if (method === 'GET' && url === '/api/call-reviews') {
   275|    try {
   276|      const reviews = readReviews();
   277|      res.writeHead(200, { 'Content-Type': 'application/json' });
   278|      res.end(JSON.stringify(reviews));
   279|    } catch (e) {
   280|      res.writeHead(500, { 'Content-Type': 'application/json' });
   281|      res.end(JSON.stringify({ error: e.message }));
   282|    }
   283|    return;
   284|  }
   285|
   286|  // ── GET /api/fathom/calls ──
   287|  if (method === 'GET' && url === '/api/fathom/calls') {
   288|    try {
   289|      const data = await fetchFathomMeetings();
   290|      res.writeHead(200, { 'Content-Type': 'application/json' });
   291|      res.end(JSON.stringify(data));
   292|    } catch (e) {
   293|      console.error('Fathom API error:', e.message);
   294|      res.writeHead(500, { 'Content-Type': 'application/json' });
   295|      res.end(JSON.stringify({ error: e.message }));
   296|    }
   297|    return;
   298|  }
   299|
   300|  // ── Serve index.html for all other requests ──
   301|  const filePath = path.join(__dirname, 'index.html');
   302|  fs.readFile(filePath, (err, data) => {
   303|    if (err) {
   304|      res.writeHead(500);
   305|      res.end('Error loading page');
   306|      return;
   307|    }
   308|    res.writeHead(200, { 'Content-Type': 'text/html' });
   309|    res.end(data);
   310|  });
   311|});
   312|
   313|server.listen(PORT, () => {
   314|  console.log(`Mission Control running on port ${PORT}`);
   315|});
   316|