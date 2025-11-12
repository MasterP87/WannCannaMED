// Client-side script to poll for unread messages and update the badge in the navigation.
// The badge element must have the id "unread-badge". The script queries the
// endpoint /api/unread-count every 30 seconds and toggles the badge visibility
// based on the returned count.

document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('unread-badge');
  if (!badge) return;

  async function updateBadge() {
    try {
      const res = await fetch('/api/unread-count');
      if (!res.ok) return;
      const data = await res.json();
      const count = data && data.count ? parseInt(data.count, 10) : 0;
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    } catch (err) {
      // Silently ignore errors; the badge will not be updated
      console.error('Failed to fetch unread count', err);
    }
  }

  // Initial fetch and periodic updates
  updateBadge();
  setInterval(updateBadge, 30000);
});