import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  SafeAreaView,
  StatusBar,
} from 'react-native';

import * as api from '../services/api';
import { PresenceSocket } from '../services/presenceSocket';

type User = api.User;

// Helpers: label from bucket
function bucketToLabel(bucket?: string | null) {
  if (!bucket) return null;

  // Normalize common buckets
  switch (bucket) {
    case 'active_now':
      return 'ACTIVE NOW';
    case 'active_5m':
      return 'ACTIVE 5M';
    case 'active_15m':
      return 'ACTIVE 15M';
    case 'active_1h':
      return 'ACTIVE 1H';
    case 'active_24h':
      return 'ACTIVE TODAY';
    case 'inactive':
      return null;
    default:
      return String(bucket).replaceAll('_', ' ').toUpperCase();
  }
}

// IMPORTANT: online overrides bucket always
function getPresenceDisplay(u: any): { label: string; badge: any } {
  const online = u?.online;

  if (online === true) {
    return { label: 'ONLINE', badge: styles.statusOnline };
  }

  const activeLabel = bucketToLabel(u?.bucket);
  if (activeLabel) {
    return { label: activeLabel, badge: styles.statusActive };
  }

  if (online === false) {
    return { label: 'OFFLINE', badge: styles.statusOffline };
  }

  return { label: '…', badge: styles.statusUnknown };
}

export default function Home() {
  const [email, setEmail] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<PresenceSocket | null>(null);

  // Focus window tracking
  const focusSetRef = useRef<Set<string>>(new Set());
  const usersRef = useRef<User[]>([]);
  const currentUserRef = useRef<string | null>(null);

  // Tune these
  const FOCUS_BUFFER_COUNT = 30;
  const MAX_FOCUS_PER_CLIENT = 100;
  const PULL_REFRESH_MS = 10_000;

  useEffect(() => {
    usersRef.current = Array.isArray(users) ? users : [];
  }, [users]);

  useEffect(() => {
    currentUserRef.current = currentUser ?? null;
  }, [currentUser]);

  useEffect(() => {
    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  // Merge incoming user objects by email (preserve existing fields)
  const mergeUsers = useCallback((incoming: any[]) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return;

    setUsers((prev) => {
      const p = Array.isArray(prev) ? prev : [];
      const map = new Map<string, any>(p.map((u) => [u.email, u]));

      for (const inc of incoming) {
        if (!inc?.email) continue;

        const existing = map.get(inc.email) || { email: inc.email };

        // Only overwrite fields that are present on incoming.
        // This prevents accidental "bucket disappears" or "online becomes false" from undefined.
        const merged: any = { ...existing };

        if ('online' in inc) merged.online = inc.online;
        if ('bucket' in inc) merged.bucket = inc.bucket;
        if ('lastActiveAt' in inc) merged.lastActiveAt = inc.lastActiveAt;
        if ('lastSeen' in inc) merged.lastSeen = inc.lastSeen;

        map.set(inc.email, merged);
      }

      return Array.from(map.values());
    });
  }, []);

  const applyFocusDelta = useCallback((nextEmails: string[]) => {
    const socket = socketRef.current;
    if (!socket) return;

    const nextSet = new Set(nextEmails);
    const prevSet = focusSetRef.current;

    const toFocus: string[] = [];
    const toBlur: string[] = [];

    for (const e of nextSet) if (!prevSet.has(e)) toFocus.push(e);
    for (const e of prevSet) if (!nextSet.has(e)) toBlur.push(e);

    focusSetRef.current = nextSet;

    if (toFocus.length) socket.focus(toFocus);
    if (toBlur.length) socket.blur(toBlur);
  }, []);

  const connectWebSocket = (userEmail: string) => {
    const socket = new PresenceSocket({
      onPresenceUpdate: (changedEmail: string, online: boolean) => {
        // WS pushes only online/offline
        mergeUsers([{ email: changedEmail, online }]);
      },

      onAuthSuccess: () => {
        setConnected(true);
        // Focus is driven by viewability.
      },

      // If your server returns snapshot on focus:ok, merge it
      onFocusSuccess: (usersOrStatuses?: any[]) => {
        if (Array.isArray(usersOrStatuses)) mergeUsers(usersOrStatuses);
      },

      onError: (errorMsg: string) => {
        console.error('WebSocket error:', errorMsg);
        setError(errorMsg);
      },

      onConnectionChange: (isConnected: boolean) => {
        setConnected(isConnected);
      },
    });

    socket.connect(userEmail);
    socketRef.current = socket;
  };

  const handleLogin = async () => {
    if (!email.trim()) {
      setError('Please enter an email');
      return;
    }
    if (!email.includes('@')) {
      setError('Please enter a valid email');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await api.login(email.trim());
      if (!response?.ok) {
        setError(response?.error || 'Login failed');
        return;
      }

      const normalizedEmail = response.email!;
      setCurrentUser(normalizedEmail);
      setLoggedIn(true);

      const usersResponse = await api.getUsers(undefined, 50);
      const userList = Array.isArray(usersResponse?.users) ? usersResponse.users : [];

      setUsers(userList);
      setHasMore(Boolean(usersResponse?.hasMore));

      connectWebSocket(normalizedEmail);
    } catch (err) {
      console.error('Login error:', err);
      setError('An error occurred during login');
    } finally {
      setLoading(false);
    }
  };

  const loadMoreUsers = async () => {
    const safeUsers = Array.isArray(users) ? users : [];
    if (loadingMore || !hasMore || safeUsers.length === 0) return;

    setLoadingMore(true);
    try {
      const lastUser = safeUsers[safeUsers.length - 1];
      const response = await api.getUsers(lastUser.email, 50);

      const nextUsers = Array.isArray(response?.users) ? response.users : [];
      if (nextUsers.length > 0) {
        setUsers((prev) => {
          const p = Array.isArray(prev) ? prev : [];
          return [...p, ...nextUsers];
        });
        setHasMore(Boolean(response?.hasMore));
      } else {
        setHasMore(false);
      }
    } catch (err) {
      console.error('Load more error:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleLogout = () => {
    const socket = socketRef.current;
    if (socket) {
      const focused = Array.from(focusSetRef.current);
      if (focused.length) socket.blur(focused);
      focusSetRef.current = new Set();
      socket.disconnect();
      socketRef.current = null;
    }

    setLoggedIn(false);
    setCurrentUser(null);
    setUsers([]);
    setConnected(false);
    setEmail('');
    setHasMore(false);
  };

  // Viewability-driven focus window (visible + buffer)
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 });

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    const me = currentUserRef.current;
    const all = usersRef.current;

    const visibleEmails: string[] = (viewableItems || [])
      .map((v: any) => v?.item?.email)
      .filter(Boolean)
      .filter((e: string) => e !== me);

    const lastIndex = Math.max(
      ...(viewableItems || []).map((v: any) => (typeof v?.index === 'number' ? v.index : -1)),
      -1
    );

    const buffer: string[] = [];
    for (let i = lastIndex + 1; i < Math.min(all.length, lastIndex + 1 + FOCUS_BUFFER_COUNT); i++) {
      const e = all[i]?.email;
      if (e && e !== me) buffer.push(e);
    }

    const combined = [...new Set([...visibleEmails, ...buffer])].slice(0, MAX_FOCUS_PER_CLIENT);
    applyFocusDelta(combined);
  }).current;

  // 10s pull refresh for focused window (TTL expiry becomes visible here)
  useEffect(() => {
    let timer: any = null;
    let cancelled = false;

    const tick = async () => {
      const getPresenceBatch = (api as any).getPresenceBatch;
      if (typeof getPresenceBatch !== 'function') return;

      const emails = Array.from(focusSetRef.current);
      if (emails.length === 0) return;

      try {
        const result = await getPresenceBatch(emails);
        if (cancelled) return;

        // Your backend returns: { users: [...] } OR just [...]
        const arr = Array.isArray(result) ? result : Array.isArray(result?.users) ? result.users : [];
        if (arr.length === 0) return;

        mergeUsers(arr);
      } catch {
        // best effort
      }
    };

    if (loggedIn) {
      tick();
      timer = setInterval(tick, PULL_REFRESH_MS);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [loggedIn, mergeUsers]);

  const renderUserItem = ({ item }: { item: any }) => {
    const { label, badge } = getPresenceDisplay(item);

    return (
      <View style={styles.userItem}>
        <View style={styles.userInfo}>
          <Text style={styles.userEmail}>{item?.email}</Text>

          {/* Optional debug line: comment out when done */}
          {/* <Text style={styles.debugText}>{`online=${String(item?.online)} bucket=${String(item?.bucket)}`}</Text> */}
        </View>

        <View style={[styles.statusBadge, badge]}>
          <Text style={styles.statusText}>{label}</Text>
        </View>
      </View>
    );
  };

  if (!loggedIn) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.loginContainer}>
          <Text style={styles.title}>Presence Tracker</Text>
          <Text style={styles.subtitle}>Enter your email to login</Text>

          <TextInput
            style={styles.input}
            placeholder="email@example.com"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!loading}
          />

          {error && <Text style={styles.errorText}>{error}</Text>}

          <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleLogin} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Login</Text>}
          </TouchableOpacity>

          <Text style={styles.infoText}>No password required. Just enter any email with @ symbol.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const safeUsers = Array.isArray(users) ? users : [];

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Users</Text>
          <Text style={styles.headerSubtitle}>Logged in as: {currentUser}</Text>
        </View>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Text style={styles.logoutButtonText}>Logout</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.connectionStatus}>
        <View style={[styles.connectionDot, connected ? styles.connectionDotConnected : styles.connectionDotDisconnected]} />
        <Text style={styles.connectionText}>{connected ? 'Connected' : 'Disconnected'}</Text>
      </View>

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <FlatList
        data={safeUsers.filter((u: any) => u?.email && u.email !== currentUser)}
        renderItem={renderUserItem}
        keyExtractor={(item: any) => item.email}
        contentContainerStyle={styles.listContainer}
        onEndReached={loadMoreUsers}
        onEndReachedThreshold={0.5}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig.current}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No users yet</Text>
          </View>
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.loadingMore}>
              <ActivityIndicator size="small" color="#007AFF" />
              <Text style={styles.loadingMoreText}>Loading more...</Text>
            </View>
          ) : hasMore ? (
            <TouchableOpacity style={styles.loadMoreButton} onPress={loadMoreUsers}>
              <Text style={styles.loadMoreText}>Load more</Text>
            </TouchableOpacity>
          ) : safeUsers.length > 0 ? (
            <Text style={styles.endOfListText}>End of list</Text>
          ) : null
        }
      />

      <View style={styles.footer}>
        <Text style={styles.footerText}>{safeUsers.length} users loaded • Focus + 10s pull refresh</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  loginContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  title: { fontSize: 32, fontWeight: 'bold', marginBottom: 8, color: '#333' },
  subtitle: { fontSize: 16, color: '#666', marginBottom: 32 },
  input: {
    width: '100%',
    height: 50,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 16,
    backgroundColor: '#fff',
    marginBottom: 16,
  },
  button: {
    width: '100%',
    height: 50,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  errorText: { color: '#ff3b30', fontSize: 14, marginBottom: 12, textAlign: 'center' },
  infoText: { fontSize: 14, color: '#999', textAlign: 'center' },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#333' },
  headerSubtitle: { fontSize: 14, color: '#666', marginTop: 2 },
  logoutButton: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: '#007AFF' },
  logoutButtonText: { color: '#007AFF', fontSize: 14, fontWeight: '600' },

  connectionStatus: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff' },
  connectionDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  connectionDotConnected: { backgroundColor: '#34C759' },
  connectionDotDisconnected: { backgroundColor: '#FF3B30' },
  connectionText: { fontSize: 14, color: '#666' },

  errorContainer: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#ffebee' },

  listContainer: { padding: 16 },
  userItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderRadius: 8,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  userInfo: { flex: 1 },
  userEmail: { fontSize: 16, fontWeight: '500', color: '#333' },

  // debugText: { marginTop: 4, fontSize: 11, color: '#777' },

  statusBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
  statusOnline: { backgroundColor: '#d4edda' },
  statusActive: { backgroundColor: '#fff3cd' }, // "active recently"
  statusOffline: { backgroundColor: '#f8d7da' },
  statusUnknown: { backgroundColor: '#eee' },
  statusText: { fontSize: 12, fontWeight: '600', color: '#333' },

  emptyContainer: { padding: 32, alignItems: 'center' },
  emptyText: { fontSize: 16, color: '#999' },

  loadingMore: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', padding: 16 },
  loadingMoreText: { marginLeft: 8, fontSize: 14, color: '#666' },
  loadMoreButton: { padding: 16, alignItems: 'center' },
  loadMoreText: { fontSize: 14, color: '#007AFF', fontWeight: '600' },
  endOfListText: { textAlign: 'center', padding: 16, fontSize: 14, color: '#999' },

  footer: { padding: 16, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e0e0e0' },
  footerText: { fontSize: 12, color: '#999', textAlign: 'center' },
});
