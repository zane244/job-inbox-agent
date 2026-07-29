#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
console.log('Loaded env keys:', Object.keys(process.env).filter(k => k.includes('GMAIL') || k.includes('ANTHROPIC')));
console.log('Has refresh token?', !!process.env.GMAIL_REFRESH_TOKEN);
console.log('Has access token?', !!process.env.GMAIL_ACCESS_TOKEN);
console.log('Has client ID?', !!process.env.GMAIL_CLIENT_ID);

/**
 * Job Application Inbox Agent
 * Automatically manages job application emails
 * - Filters spam
 * - Labels relevant opportunities
 * - Flags important emails
 * - Creates draft replies
 * - Sends daily summary
 */

import { gmail_v1, google } from "googleapis";
import { Anthropic } from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";

// Configuration
const CONFIG = {
  MAX_EMAILS: 100,
  LABELS: {
    REVIEW: "Review",
    NON_WORK: "Non-Work",
  },
  IDENTITY_FILES: {
    soul: `SOUL FILE
Tone: Bubbly but professional, warm, encouraging—like a supportive friend.
Core values: Accuracy first, Respect user's time, Whole-hearted effort.

IDENTITY FILE
Role: Inbox Assistant
Hard boundaries: Never auto-send, never delete permanently, never access other accounts.
Confidence threshold: Moderate (flag borderline cases).

USER FILE
Status: Unemployed, full-time job search, pragmatic.
Target roles: Assistant, Receptionist, Agent, phone roles (entry-to-intermediate).
Location: Remote OR Durban North, KwaZulu-Natal.
Job criteria: Remote preferred, no experience required, entry-level only.
Risk tolerance: When unsure, flag rather than archive.`,
  },
};

// Initialize clients
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Create OAuth2 client first
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  "http://localhost:3000/oauth2callback"
);

// Set the tokens
oauth2Client.setCredentials({
  access_token: process.env.GMAIL_ACCESS_TOKEN,
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

// Now create the Gmail client with the authenticated client
const gmail = google.gmail({
  version: "v1",
  auth: oauth2Client,
});

// Now create the Gmail client with the authenticated client
const gmail = google.gmail({
  version: "v1",
  auth: oauth2Client,
});

/**
 * Main agent function
 */
async function runAgent() {
  console.log("🤖 Job Application Inbox Agent starting...");
  console.log(`⏰ Started at: ${new Date().toISOString()}`);

  try {
    // Step 1: Fetch unread emails
    console.log("\n📧 Fetching unread emails...");
    const emails = await fetchUnreadEmails();
    console.log(`Found ${emails.length} unread emails`);

    if (emails.length === 0) {
      console.log("✅ Inbox already clean!");
      await sendSummaryEmail({
        spam_archived: 0,
        relevant_reviewed: 0,
        flagged: 0,
        drafts_created: 0,
        top_3_opportunities: [],
        critical_alerts: [],
        notes: "No unread emails found.",
      });
      return;
    }

    // Step 2: Process emails with Claude
    console.log("\n🧠 Processing emails with Claude...");
    const processedEmails = await processEmailsWithClaude(emails);

    // Step 3: Apply actions to Gmail
    console.log("\n⚙️ Applying actions to Gmail...");
    const results = await applyGmailActions(processedEmails);

    // Step 4: Send summary
    console.log("\n📨 Sending summary email...");
    await sendSummaryEmail(results);

    console.log("\n✅ Agent completed successfully!");
    console.log(`Finished at: ${new Date().toISOString()}`);
  } catch (error) {
    console.error("❌ Error:", error.message);
    await sendErrorEmail(error);
    process.exit(1);
  }
}

/**
 * Fetch unread emails from Gmail
 */
async function fetchUnreadEmails() {
  const response = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults: CONFIG.MAX_EMAILS,
  });

  const messages = response.data.messages || [];

  // Get full message details
  const emails = await Promise.all(
    messages.map(async (msg) => {
      const fullMsg = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = fullMsg.data.payload.headers;
      const from = headers.find((h) => h.name === "From")?.value || "";
      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const to = headers.find((h) => h.name === "To")?.value || "";
      const body = getEmailBody(fullMsg.data.payload);

      return {
        id: msg.id,
        from,
        to,
        subject,
        body: body.substring(0, 2000), // Limit body size
        timestamp: fullMsg.data.internalDate,
      };
    })
  );

  return emails;
}

/**
 * Extract email body from Gmail payload
 */
function getEmailBody(payload) {
  if (payload.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart && textPart.body.data) {
      return Buffer.from(textPart.body.data, "base64").toString("utf-8");
    }
  }

  if (payload.body.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  return "";
}

/**
 * Process emails with Claude AI
 */
async function processEmailsWithClaude(emails) {
  const emailsText = emails
    .map(
      (e, i) =>
        `Email ${i + 1}:
ID: ${e.id}
From: ${e.from}
Subject: ${e.subject}
Body: ${e.body}
---`
    )
    .join("\n");

  const prompt = `You are an Inbox Assistant managing job application emails.

${CONFIG.IDENTITY_FILES.soul}

Your task: Classify each email and decide what action to take.

Job Search Criteria:
- Target roles: Assistant, Receptionist, Agent, phone/call center roles
- Location: Remote OR Durban North, South Africa
- Experience: Entry-level, Junior, Associate/Intermediate only
- Spam indicators: Application confirmations, generic job alerts, jobs requiring experience, non-remote positions
- Critical: Emails from humans (not bots), interview requests, offers, time-sensitive messages

For each email, respond with ONLY valid JSON (no other text):

{
  "classifications": [
    {
      "email_id": "string",
      "subject": "string (from email)",
      "from": "string (from email)",
      "classification": "spam | relevant | critical | non_work",
      "action": "archive | review | flag | draft_reply",
      "labels_to_add": ["string"],
      "reason": "string (brief explanation)",
      "draft_reply": "string or null (if action is draft_reply, create a friendly human-sounding reply)"
    }
  ],
  "summary": {
    "spam_count": number,
    "relevant_count": number,
    "flagged_count": number,
    "drafts_count": number,
    "top_opportunities": ["string", "string", "string"],
    "critical_alerts": ["string"]
  }
}

Emails to process:

${emailsText}`;

  const message = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const responseText = message.content[0].text;

  // Extract JSON from response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude did not return valid JSON");
  }

  const result = JSON.parse(jsonMatch[0]);

  // Enrich with original email data
  result.classifications = result.classifications.map((c) => {
    const original = emails.find((e) => e.id === c.email_id);
    return { ...original, ...c };
  });

  return result;
}

/**
 * Apply actions to Gmail
 */
async function applyGmailActions(processedData) {
  const stats = {
    spam_archived: 0,
    relevant_reviewed: 0,
    flagged: 0,
    drafts_created: 0,
    top_3_opportunities: processedData.summary.top_opportunities || [],
    critical_alerts: processedData.summary.critical_alerts || [],
  };

  // Get or create labels
  const labels = await getOrCreateLabels();

  for (const email of processedData.classifications) {
    try {
      if (email.action === "archive") {
        await gmail.users.messages.modify({
          userId: "me",
          id: email.id,
          requestBody: {
            addLabelIds: ["ARCHIVE"],
            removeLabelIds: ["UNREAD"],
          },
        });
        stats.spam_archived++;
      } else if (email.action === "review") {
        await gmail.users.messages.modify({
          userId: "me",
          id: email.id,
          requestBody: {
            addLabelIds: [labels[CONFIG.LABELS.REVIEW]],
            removeLabelIds: ["UNREAD"],
          },
        });
        stats.relevant_reviewed++;
      } else if (email.action === "flag") {
        await gmail.users.messages.modify({
          userId: "me",
          id: email.id,
          requestBody: {
            addLabelIds: ["STARRED"],
            removeLabelIds: ["UNREAD"],
          },
        });
        stats.flagged++;
      } else if (email.action === "draft_reply" && email.draft_reply) {
        await createDraft(email, email.draft_reply);
        stats.drafts_created++;
      }
    } catch (error) {
      console.error(
        `Failed to process email ${email.id} (${email.subject}):`,
        error.message
      );
    }
  }

  return stats;
}

/**
 * Get or create Gmail labels
 */
async function getOrCreateLabels() {
  const response = await gmail.users.labels.list({ userId: "me" });
  const existingLabels = response.data.labels || [];
  const labelMap = {};

  for (const label of Object.values(CONFIG.LABELS)) {
    const existing = existingLabels.find((l) => l.name === label);
    if (existing) {
      labelMap[label] = existing.id;
    } else {
      const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: label,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      labelMap[label] = created.data.id;
    }
  }

  return labelMap;
}

/**
 * Create a draft reply
 */
async function createDraft(email, replyText) {
  const message = `From: ${process.env.USER_EMAIL}
To: ${email.from}
Subject: Re: ${email.subject}

${replyText}

---
Draft created by Job Inbox Agent
`;

  await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw: Buffer.from(message).toString("base64"),
      },
    },
  });
}

/**
 * Send summary email
 */
async function sendSummaryEmail(stats) {
  const summary = `
📧 DAILY EMAIL REPORT
Generated: ${new Date().toLocaleString()}

✅ Spam archived: ${stats.spam_archived} emails
📌 Relevant opportunities moved to Review: ${stats.relevant_reviewed} emails
⭐ Flagged for your attention: ${stats.flagged} emails
✍️ Drafts created: ${stats.drafts_created} (awaiting your approval)

🎯 TOP 3 OPPORTUNITIES:
${stats.top_3_opportunities.slice(0, 3).map((opp, i) => `${i + 1}. ${opp}`).join("\n") || "None"}

⚠️ CRITICAL EMAILS:
${stats.critical_alerts.map((alert) => `• ${alert}`).join("\n") || "None"}

---
✨ Your inbox is organized and ready to go!
Next run: Tomorrow at 9 PM
`;

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.USER_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD, // Use app-specific password
    },
  });

  await transporter.sendMail({
    from: process.env.USER_EMAIL,
    to: process.env.USER_EMAIL,
    subject: "📧 Daily Email Report - Job Application Inbox",
    text: summary,
  });
}

/**
 * Send error notification
 */
async function sendErrorEmail(error) {
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.USER_EMAIL,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: process.env.USER_EMAIL,
      to: process.env.USER_EMAIL,
      subject: "❌ Job Inbox Agent Error",
      text: `An error occurred:\n\n${error.message}\n\nPlease check your configuration.`,
    });
  } catch (e) {
    console.error("Failed to send error email:", e);
  }
}

// Run agent
runAgent().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
