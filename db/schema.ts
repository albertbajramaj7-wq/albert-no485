import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const days = sqliteTable('days', {
  date: text('date').primaryKey(),
  prepared: integer('prepared'),
  dropin: integer('dropin').notNull().default(0),
  waste: integer('waste').notNull().default(0),
  paused: integer('paused').notNull().default(0),
  allowAfterClosing: integer('allow_after_closing').notNull().default(0),
  version: integer('version').notNull().default(0),
});
export const bookings = sqliteTable('bookings', {
  id: text('id').primaryKey(),
  requestKey: text('request_key').notNull(),
  date: text('date').notNull(),
  readyMin: integer('ready_min').notNull(),
  count: integer('count').notNull(),
  guests: integer('guests').notNull(),
  mode: text('mode').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull(),
  status: text('status').notNull().default('confirmed'),
  cancelReason: text('cancel_reason'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, t => [uniqueIndex('bookings_request_key').on(t.requestKey), index('bookings_day_time').on(t.date, t.readyMin)]);
export const operators = sqliteTable('operators', {
  userId: text('user_id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  createdAt: text('created_at').notNull(),
});
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  area: text('area').notNull().default('other'),
  templateKey: text('template_key'),
  done: integer('done').notNull().default(0),
  archived: integer('archived').notNull().default(0),
  updatedBy: text('updated_by').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, t => [index('tasks_day').on(t.date), uniqueIndex('tasks_day_template').on(t.date, t.templateKey)]);
export const audit = sqliteTable('audit', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: text('detail').notNull(),
  createdAt: text('created_at').notNull(),
}, t => [index('audit_day').on(t.date)]);

export const bookingEmails = sqliteTable('booking_emails', {
  bookingId: text('booking_id').primaryKey(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  payload: text('payload'),
  firstAttemptAt: integer('first_attempt_at'),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at').notNull().default(0),
  providerId: text('provider_id'),
  lastError: text('last_error'),
  sentAt: text('sent_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
