import React, { useState, useEffect, useRef } from 'react';
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
import { login, getUsers, User } from '../services/api';
import { PresenceSocket } from '../services/presenceSocket';

export default function Home() {
  const [email, setEmail] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<PresenceSocket | null>(null);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

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
      // Call login API
      const response = await login(email.trim());

      if (!response.ok) {
        setError(response.error || 'Login failed');
        setLoading(false);
        return;
      }

      const normalizedEmail = response.email!;
      setCurrentUser(normalizedEmail);
      setLoggedIn(true);

      // Fetch initial user list
      await fetchUsers();

      // Connect to WebSocket
      connectWebSocket(normalizedEmail);

      setLoading(false);
    } catch (err) {
      console.error('Login error:', err);
      setError('An error occurred during login');
      setLoading(false);
    }
  };

  const handleLogout = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    setLoggedIn(false);
    setCurrentUser(null);
    setUsers([]);
    setConnected(false);
    setEmail('');
  };

  const fetchUsers = async () => {
    const response = await getUsers();
    setUsers(response.users);
  };

  const connectWebSocket = (userEmail: string) => {
    const socket = new PresenceSocket({
      onPresenceUpdate: (email, online) => {
        setUsers((prevUsers) => {
          // Check if user exists in the list
          const userExists = prevUsers.some((u) => u.email === email);

          if (userExists) {
            // Update existing user
            return prevUsers.map((u) =>
              u.email === email ? { ...u, online } : u
            );
          } else {
            // Add new user
            return [...prevUsers, { email, online }];
          }
        });
      },
      onAuthSuccess: (email, heartbeatMs, ttlSeconds) => {
        console.log(`Auth success: ${email}`);
        setConnected(true);
      },
      onError: (errorMsg) => {
        console.error('WebSocket error:', errorMsg);
        setError(errorMsg);
      },
      onConnectionChange: (isConnected) => {
        setConnected(isConnected);
      },
    });

    socket.connect(userEmail);
    socketRef.current = socket;
  };

  const renderUserItem = ({ item }: { item: User }) => {
    const isCurrentUser = item.email === currentUser;

    return (
      <View style={styles.userItem}>
        <View style={styles.userInfo}>
          <Text style={styles.userEmail}>
            {item.email} {isCurrentUser && '(You)'}
          </Text>
        </View>
        <View
          style={[
            styles.statusBadge,
            item.online ? styles.statusOnline : styles.statusOffline,
          ]}
        >
          <Text style={styles.statusText}>
            {item.online ? 'ONLINE' : 'OFFLINE'}
          </Text>
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

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Login</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.infoText}>
            No password required. Just enter any email with @ symbol.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

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
        <View
          style={[
            styles.connectionDot,
            connected ? styles.connectionDotConnected : styles.connectionDotDisconnected,
          ]}
        />
        <Text style={styles.connectionText}>
          {connected ? 'Connected' : 'Disconnected'}
        </Text>
      </View>

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <FlatList
        data={users}
        renderItem={renderUserItem}
        keyExtractor={(item) => item.email}
        contentContainerStyle={styles.listContainer}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No users yet</Text>
          </View>
        }
      />

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          User status updates in real-time via WebSocket
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  loginContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#333',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 32,
  },
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
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  errorText: {
    color: '#ff3b30',
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
  },
  infoText: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  logoutButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  logoutButtonText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
  },
  connectionStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  connectionDotConnected: {
    backgroundColor: '#34C759',
  },
  connectionDotDisconnected: {
    backgroundColor: '#FF3B30',
  },
  connectionText: {
    fontSize: 14,
    color: '#666',
  },
  errorContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#ffebee',
  },
  listContainer: {
    padding: 16,
  },
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
  userInfo: {
    flex: 1,
  },
  userEmail: {
    fontSize: 16,
    fontWeight: '500',
    color: '#333',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusOnline: {
    backgroundColor: '#d4edda',
  },
  statusOffline: {
    backgroundColor: '#f8d7da',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
  },
  emptyContainer: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: '#999',
  },
  footer: {
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  footerText: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
  },
});
