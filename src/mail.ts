import nodemailer from 'nodemailer';
import type { Match } from './matching.js';

type Recipient = { email: string; name: string };

export type MatchNotification = {
  recipientEmails: string[];
  subject: string;
  body: string;
};

export function createMatchNotification(participants: Recipient[], match: Match): MatchNotification {
  const subject = 'Your next Fika conversation is ready';
  const names = participants.map((participant) => participant.name).join(', ');
  return {
    recipientEmails: participants.map((participant) => participant.email),
    subject,
    body: `Hi ${names},\n\nYour next Fika match is ready. Make time for a good conversation.\n\nParticipants: ${match.participantIds.join(', ')}`
  };
}

export async function sendNotification(notification: MatchNotification): Promise<void> {
  if (!process.env.SMTP_HOST) {
    console.log(`[mail:mock] ${notification.subject} -> ${notification.recipientEmails.join(', ')}`);
    return;
  }

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
  });
  await transport.sendMail({
    from: process.env.MAIL_FROM ?? 'Fika <hello@localhost>',
    to: notification.recipientEmails,
    subject: notification.subject,
    text: notification.body
  });
}
