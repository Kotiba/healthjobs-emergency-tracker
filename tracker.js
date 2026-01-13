import 'dotenv/config';
import { chromium } from 'playwright';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

// ============================================================================
// CONFIGURATION - HealthJobsUK Emergency Medicine Tracker
// ============================================================================

const SELECTORS = {
  JOB_ITEM: 'li.hj-job',
  JOB_LINK: 'a',
  JOB_TITLE: '.hj-jobtitle',
  JOB_GRADE: '.hj-grade',
  JOB_EMPLOYER: '.hj-employername',
  JOB_LOCATION: '.hj-locationtown',
  JOB_SPECIALITY: '.hj-primaryspeciality',
  JOB_SALARY: '.hj-salary'
};

const CONFIG = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  // HealthJobsUK Emergency Medicine search URL with filters
  // searchUrl: 'https://www.healthjobsuk.com/job_list?JobSearch_q=&JobSearch_d=534&JobSearch_g=255&JobSearch_re=_POST&JobSearch_re_0=1&JobSearch_re_1=1-_-_-&JobSearch_re_2=1-_-_--_-_-&JobSearch_Submit=Search&_tr=JobSearch&_ts=19519',
  searchUrl: 'https://www.healthjobsuk.com/job_list?JobSearch_q=&JobSearch_d=534&JobSearch_g=&JobSearch_re=_POST&JobSearch_re_0=1&JobSearch_re_1=1-_-_-&JobSearch_re_2=1-_-_--_-_-&JobSearch_Submit=Search&_tr=JobSearch&_ts=21248',
  baseUrl: 'https://www.healthjobsuk.com',
  dataFile: path.join(process.cwd(), 'data', 'jobs.json'),
  headless: process.env.CI === 'true'
};

// ============================================================================
// TRACKER
// ============================================================================

async function runTracker() {
  const startTime = Date.now();
  console.log(`🚑 Starting HealthJobs Emergency Tracker...`);

  // Validate Telegram config
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 }
  });
  const page = await context.newPage();

  try {
    // Navigate to search page
    console.log('📂 Navigating to HealthJobsUK...');
    await page.goto(CONFIG.searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
    console.log('Current URL:', page.url());

    // Wait for job listings
    console.log('Waiting for job listings...');
    await page.waitForSelector(SELECTORS.JOB_ITEM, { state: 'visible', timeout: 15000 }).catch(() => null);

    const jobCount = await page.locator(SELECTORS.JOB_ITEM).count();
    console.log(`Found ${jobCount} job listings`);

    // Scrape jobs
    const jobs = await page.evaluate(({ selectors, baseUrl }) => {
      const results = [];
      document.querySelectorAll(selectors.JOB_ITEM).forEach(item => {
        const link = item.querySelector(selectors.JOB_LINK);
        const title = item.querySelector(selectors.JOB_TITLE)?.textContent?.trim() || '';
        if (!title) return;

        const href = link?.getAttribute('href') || '';
        const fullUrl = href.startsWith('/') ? baseUrl + href : href;

        results.push({
          id: href.split('?')[0] || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          title,
          grade: item.querySelector(selectors.JOB_GRADE)?.textContent?.trim() || '',
          employer: item.querySelector(selectors.JOB_EMPLOYER)?.textContent?.trim() || '',
          location: item.querySelector(selectors.JOB_LOCATION)?.textContent?.trim() || '',
          speciality: item.querySelector(selectors.JOB_SPECIALITY)?.textContent?.trim().replace('Speciality:', '').trim() || '',
          salary: item.querySelector(selectors.JOB_SALARY)?.textContent?.trim().replace('Salary:', '').trim() || '',
          link: fullUrl,
          scrapedAt: new Date().toISOString()
        });
      });
      return results;
    }, { selectors: SELECTORS, baseUrl: CONFIG.baseUrl });

    console.log(`✅ Scraped ${jobs.length} jobs`);

    // Load previous jobs
    let previousJobs = [];
    try {
      previousJobs = JSON.parse(await fs.readFile(CONFIG.dataFile, 'utf-8'));
    } catch { }

    // Find new jobs
    const previousIds = new Set(previousJobs.map(j => j.id));
    const newJobs = jobs.filter(j => !previousIds.has(j.id));

    console.log(`🆕 Found ${newJobs.length} new job(s)`);

    // Notify for new jobs
    for (const job of newJobs) {
      const msg = `🚨 <b>New Emergency Job!</b>\n\n<b>${job.title}</b>\n\n🏥 ${job.employer}\n📍 ${job.location}\n� ${job.salary}\n\n<a href="${job.link}">View Job</a>`;
      await axios.post(`https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`, {
        chat_id: CONFIG.telegramChatId, text: msg, parse_mode: 'HTML'
      }).catch(e => console.error('Telegram error:', e.message));
    }

    // Save jobs (merge with previous)
    const mergedJobs = new Map();
    previousJobs.forEach(j => mergedJobs.set(j.id, j));
    jobs.forEach(j => mergedJobs.set(j.id, j));
    await fs.mkdir(path.dirname(CONFIG.dataFile), { recursive: true });
    await fs.writeFile(CONFIG.dataFile, JSON.stringify([...mergedJobs.values()], null, 2));

    // Send completion notification
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const timestamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

    let status;
    if (newJobs.length > 0) {
      status = `✅ HealthJobs run completed! 🎉 Found <b>${newJobs.length}</b> new job(s) out of ${jobs.length} scraped (${elapsed}s).`;
    } else {
      status = `✅ HealthJobs run completed. Scraped ${jobs.length} jobs, <b>no new</b> ones found (${elapsed}s). 🕵️`;
    }

    await axios.post(`https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`, {
      chat_id: CONFIG.telegramChatId, text: `${status}\n\n<i>Checked at: ${timestamp}</i>`, parse_mode: 'HTML'
    }).catch(e => console.error('Telegram error:', e.message));

    console.log(`✅ Done in ${elapsed}s`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`, {
      chat_id: CONFIG.telegramChatId, text: `❌ <b>HealthJobs Tracker Failed</b>: ${error.message}`, parse_mode: 'HTML'
    }).catch(() => { });
    throw error;
  } finally {
    await browser.close();
  }
}

runTracker().catch(() => process.exit(1));
