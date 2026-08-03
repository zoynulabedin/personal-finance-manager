# 🏠 Personal Family Finance Manager

> A personal finance management web application built with React Router Framework, Tailwind CSS, Prisma, and PostgreSQL.

---

# Goal

এই প্রজেক্টের উদ্দেশ্য হলো আমার নিজের পরিবারের সমস্ত আয়-ব্যয়ের হিসাব একটি জায়গায় সংরক্ষণ করা।

এটি শুধুমাত্র একজন ব্যবহারকারীর জন্য (Single User System)।

Features:

- Monthly Income
- 1% Donation Calculation
- Bank Balance Management
- Daily Expense Tracking
- Monthly Bills
- Financial Reports
- Dashboard Analytics
- Bengali Interface
- Responsive Design

---

# Tech Stack

## Frontend

- React Router Framework
- React 19
- TypeScript
- Tailwind CSS
- Shadcn UI
- Lucide Icons

---

## Backend

- React Router Loader/Action
- Prisma ORM
- PostgreSQL

---

## Authentication

Simple Login

- Single User
- Email
- Password

No Registration

---

# Folder Structure

```
app/

    components/

    routes/

    lib/

    prisma/

    utils/

    types/

```

---

# Database Design

---

## User

```
id
name
email
password
createdAt
updatedAt
```

---

## Monthly Income

```
id

title

amount

month

year

note

createdAt
```

Example

```
Salary
Freelancing
Business
Other Income
```

---

## Donation

Automatically calculate

```
Donation = Income × 1%
```

Fields

```
id

incomeId

percentage

amount

paid

paidDate
```

---

## Bank Accounts

```
id

bankName

accountName

accountNumber

currentBalance

note

createdAt
```

Example

```
Dutch Bangla

Islami Bank

Nagad

bKash

Cash
```

Balance manually update হবে।

---

## Categories

Expense Category

```
id

name

icon

color
```

Default Categories

```
🍚 বাজার

🏠 বাসা ভাড়া

⚡ বিদ্যুৎ বিল

💧 পানির বিল

🔥 গ্যাস বিল

📶 ইন্টারনেট

📱 মোবাইল রিচার্জ

🚗 যাতায়াত

🍔 খাবার

🏥 চিকিৎসা

🎓 শিক্ষা

👕

পোশাক

🎁 উপহার

💰 দান

👶 সন্তান

🛠 মেরামত

🛒 শপিং

📦 অন্যান্য
```

---

## Daily Expenses

```
id

date

categoryId

title

amount

paymentMethod

bankAccountId

note
```

Example

```
আজ বাজার

৫২০ টাকা

Cash
```

---

## Monthly Bills

```
id

title

amount

dueDate

paid

paidDate
```

Examples

```
Electricity

Water

Gas

Rent

Internet

School Fee
```

---

## Payment Method

```
Cash

Bank

bKash

Nagad

Rocket
```

---

# Dashboard

Dashboard এ দেখাবে

```
Current Month Income

Current Month Expense

Remaining Balance

Donation

Bank Balance

Cash Balance

Pending Bills

Today's Expense

This Month Expense

This Year Expense
```

---

# Reports

Monthly Report

```
Income

Expense

Donation

Savings
```

---

Category Report

```
Food

Rent

Electricity

Transport

Medical
```

---

Yearly Report

```
Income

Expense

Donation

Savings
```

---

# Dashboard Charts

Monthly Expense Chart

Category Pie Chart

Income vs Expense

Savings Trend

---

# Pages

## Login

Simple Login

---

## Dashboard

Financial Summary

---

## Income

- Add Income
- Edit Income
- Delete Income

---

## Donation

Automatic 1%

Donation History

---

## Bank Accounts

- Add Bank

- Update Balance

- View Balance

---

## Expenses

- Add Expense

- Edit

- Delete

- Filter

---

## Bills

- Add Bill

- Mark Paid

- Upcoming Bills

---

## Categories

Expense Categories

CRUD

---

## Reports

Monthly

Yearly

Category

---

## Settings

Profile

Password

Theme

Backup

---

# Expense Flow

```
Income Added

↓

Donation 1% Calculated

↓

Bank Balance Updated

↓

Expense Added

↓

Bank Balance Reduced (optional/manual)

↓

Dashboard Updated

```

---

# Search

Search Expense

Search Income

Search Bills

Search Category

---

# Filters

Today

Yesterday

Last 7 Days

This Month

Last Month

This Year

Custom Date

---

# Dashboard Cards

✅ Total Income

✅ Total Expense

✅ Savings

✅ Donation

✅ Cash

✅ Bank Balance

✅ Bills Due

✅ Today's Expense

---

# Nice Features

✅ Bengali Numbers

```
১ ২ ৩ ৪ ৫ ৬ ৭ ৮ ৯
```

---

Currency

```
৳
```

---

Date Format

```
০৩ আগস্ট ২০২৬
```

---

# Future Features

- Budget Planning
- Investment Tracking
- Loan Management
- Asset Management
- Family Members
- Recurring Expenses
- Notifications
- Export PDF
- Export Excel
- Mobile PWA
- Dark Mode
- Google Drive Backup

---

# Security

- Password Hashing
- Session Authentication
- CSRF Protection
- Secure Cookies
- Prisma Validation

---

# Development Roadmap

## Phase 1

- Authentication
- Dashboard
- Income
- Expense

---

## Phase 2

- Donation
- Bank Accounts
- Bills

---

## Phase 3

- Reports
- Charts
- Filters

---

## Phase 4

- Backup
- Export
- PWA

---

# Project Name Ideas

- Amar Hisab
- Poribar Finance
- Family Ledger
- Personal Finance
- Amar Khoroch
- Amar AyBay
- Hisab Khata
- Finance Diary

---

# Final Goal

একটি দ্রুত, সহজ, বাংলা ভাষার ব্যক্তিগত ফাইন্যান্স ম্যানেজমেন্ট সিস্টেম, যেখানে পরিবারের প্রতিদিনের আয়-ব্যয়, ব্যাংক ব্যালেন্স, মাসিক বিল, ১% দান এবং সঞ্চয়ের পূর্ণাঙ্গ হিসাব একটি ড্যাশবোর্ডে দেখা যাবে।