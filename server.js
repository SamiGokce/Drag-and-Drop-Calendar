const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static('public'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// In-memory token store (persists across warm invocations)
let savedTokens = process.env.GOOGLE_TOKENS ? JSON.parse(process.env.GOOGLE_TOKENS) : null;
if (savedTokens) oauth2Client.setCredentials(savedTokens);

// Google OAuth routes
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  savedTokens = tokens;
  res.redirect('/?authed=1');
});

app.get('/auth/status', (req, res) => {
  res.json({ authed: !!savedTokens });
});

// Parse content with Groq
async function parseContentWithGroq(textContent, imageFiles) {
  const prompt = `Extract all calendar events from the content provided. Return a JSON array of events with this structure:
[{
  "title": "Event title",
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM" or null if all-day,
  "endTime": "HH:MM" or null,
  "description": "Any extra details",
  "location": "Location if mentioned" or null
}]

Today's date is ${new Date().toISOString().split('T')[0]}.
If a year isn't specified, assume the nearest upcoming date.
Return ONLY the JSON array, no other text.${textContent ? `\n\nContent to parse:\n${textContent}` : ''}`;

  const contentParts = [{ type: 'text', text: prompt }];

  for (const file of imageFiles) {
    const base64 = file.buffer.toString('base64');
    const mimeType = file.mimetype || 'image/jpeg';
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64}` },
    });
  }

  const response = await groq.chat.completions.create({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    messages: [{ role: 'user', content: contentParts }],
    max_tokens: 2048,
  });

  const raw = response.choices[0].message.content.trim();
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(cleaned);
}

// Create Google Calendar events
async function createCalendarEvents(events) {
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const created = [];

  for (const event of events) {
    let resource;

    if (!event.startTime) {
      resource = {
        summary: event.title,
        description: event.description || '',
        location: event.location || '',
        start: { date: event.date },
        end: { date: event.date },
      };
    } else {
      const start = `${event.date}T${event.startTime}:00`;
      const end = event.endTime ? `${event.date}T${event.endTime}:00` : `${event.date}T${event.startTime}:00`;
      resource = {
        summary: event.title,
        description: event.description || '',
        location: event.location || '',
        start: { dateTime: start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        end: { dateTime: end, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      };
    }

    const result = await calendar.events.insert({ calendarId: 'primary', resource });
    created.push({ ...event, calendarLink: result.data.htmlLink });
  }

  return created;
}

// Main parse endpoint
app.post('/parse', upload.array('files'), async (req, res) => {
  const textContent = req.body.text || '';
  const imageFiles = (req.files || []).filter(f => f.mimetype && f.mimetype.startsWith('image/'));

  if (!textContent && imageFiles.length === 0) {
    return res.status(400).json({ error: 'No content provided' });
  }

  try {
    const events = await parseContentWithGroq(textContent, imageFiles);
    res.json({ events });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Confirm and create events endpoint
app.post('/create', async (req, res) => {
  const { events } = req.body;
  if (!events || !events.length) {
    return res.status(400).json({ error: 'No events to create' });
  }

  if (!savedTokens) {
    return res.status(401).json({ error: 'Not authenticated with Google' });
  }

  try {
    const created = await createCalendarEvents(events);
    res.json({ created });
  } catch (err) {
    console.error('Calendar error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));

module.exports = app;
