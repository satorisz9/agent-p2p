/**
 * TaskScanner — detects dangerous patterns in task descriptions and input.
 *
 * Scans all string content recursively for:
 *   - Credential/secret file access (~/.ssh, ~/.aws, .env, private keys)
 *   - Command injection (curl|sh, rm -rf, eval, exec)
 *   - Data exfiltration (POST to external URL, base64 encode + send)
 *   - Path traversal (../../etc/passwd)
 *   - Destructive commands (rm -rf, drop database, format)
 */

import type { TaskRequest, TaskScanResult, ThreatEntry, ThreatCategory } from "../../types/protocol";

interface PatternDef {
  category: ThreatCategory;
  pattern: RegExp;
  name: string;
}

const PATTERNS: PatternDef[] = [
  // --- Credential Access ---
  { category: "credential_access", pattern: /~?\/?\.ssh\b/i, name: ".ssh directory" },
  { category: "credential_access", pattern: /~?\/?\.aws\b/i, name: ".aws directory" },
  { category: "credential_access", pattern: /~?\/?\.gnupg\b/i, name: ".gnupg directory" },
  { category: "credential_access", pattern: /~?\/?\.kube\b/i, name: ".kube directory" },
  { category: "credential_access", pattern: /~?\/?\.docker\/config\b/i, name: ".docker/config" },
  { category: "credential_access", pattern: /\/etc\/(shadow|gshadow)\b/i, name: "/etc/shadow" },
  { category: "credential_access", pattern: /\bprivate[_\s-]?key\b/i, name: "private key reference" },
  { category: "credential_access", pattern: /\bsecret[_\s-]?key\b/i, name: "secret key reference" },
  { category: "credential_access", pattern: /\b(api[_\s-]?key|api[_\s-]?token|access[_\s-]?token)\b/i, name: "API key/token reference" },
  { category: "credential_access", pattern: /\.(pem|key|p12|pfx|jks)\b/i, name: "key file extension" },
  { category: "credential_access", pattern: /(?:^|\s|\/|\b)\.env\b/, name: ".env file" },
  { category: "credential_access", pattern: /\bcredentials?\b.*\b(file|read|cat|send|return|output)\b/i, name: "credential file operation" },
  { category: "credential_access", pattern: /\b(read|cat|send|return|output)\b.*\bcredentials?\b/i, name: "credential file operation (reversed)" },
  { category: "credential_access", pattern: /\bkeychain\b/i, name: "keychain access" },
  { category: "credential_access", pattern: /\bpassword[_\s-]?(file|store|vault)\b/i, name: "password store" },

  // --- Command Injection ---
  { category: "command_injection", pattern: /curl\b.*\|\s*(ba)?sh\b/i, name: "curl pipe to shell" },
  { category: "command_injection", pattern: /wget\b.*\|\s*(ba)?sh\b/i, name: "wget pipe to shell" },
  { category: "command_injection", pattern: /\beval\s*[\(\$]/i, name: "eval execution" },
  { category: "command_injection", pattern: /\bexec\s*[\(\$]/i, name: "exec execution" },
  { category: "command_injection", pattern: /\bsource\s+<\s*\(/i, name: "source process substitution" },
  { category: "command_injection", pattern: /\bbase64\s+(-d|--decode)\b/i, name: "base64 decode execution" },
  { category: "command_injection", pattern: /\bpython\s+-c\b/i, name: "python -c injection" },
  { category: "command_injection", pattern: /\bnode\s+-e\b/i, name: "node -e injection" },
  { category: "command_injection", pattern: /\bperl\s+-e\b/i, name: "perl -e injection" },
  { category: "command_injection", pattern: /`[^`]*`/, name: "backtick command substitution" },
  { category: "command_injection", pattern: /\$\([^)]+\)/, name: "$() command substitution" },

  // --- Data Exfiltration ---
  { category: "data_exfiltration", pattern: /\b(POST|PUT)\b.*https?:\/\//i, name: "HTTP POST/PUT to external" },
  { category: "data_exfiltration", pattern: /https?:\/\/.*\b(collect|exfil|receive|upload|webhook)\b/i, name: "suspicious exfiltration URL" },
  { category: "data_exfiltration", pattern: /\bbase64\b.*\b(encode|credentials?|secret|key|token)\b/i, name: "base64 encode sensitive data" },
  { category: "data_exfiltration", pattern: /\b(credentials?|secret|key|token)\b.*\bbase64\b/i, name: "sensitive data base64 (reversed)" },
  { category: "data_exfiltration", pattern: /\bnccat?\b.*-[elvp]/i, name: "netcat reverse shell" },
  { category: "data_exfiltration", pattern: /\b\/dev\/(tcp|udp)\b/i, name: "/dev/tcp reverse connection" },

  // --- Path Traversal ---
  { category: "path_traversal", pattern: /\.\.\/(\.\.\/){2,}/i, name: "deep path traversal" },
  { category: "path_traversal", pattern: /\.\.\/.*\/etc\//i, name: "path traversal to /etc" },

  // --- Destructive Commands ---
  { category: "destructive_command", pattern: /\brm\s+(-[rRf]+\s+)*\//i, name: "rm from root" },
  { category: "destructive_command", pattern: /\brm\s+-[rRf]{2,}/i, name: "rm -rf" },
  { category: "destructive_command", pattern: /\bmkfs\b/i, name: "filesystem format" },
  { category: "destructive_command", pattern: /\bdd\b.*\bof=\/dev\//i, name: "dd to device" },
  { category: "destructive_command", pattern: /\bdrop\s+(database|table|schema)\b/i, name: "SQL drop" },
  { category: "destructive_command", pattern: /\bformat\s+[a-z]:\\/i, name: "disk format" },
  { category: "destructive_command", pattern: /\b:(){ :\|:& };:/i, name: "fork bomb" },
  { category: "destructive_command", pattern: /\bchmod\s+777\s+\//i, name: "chmod 777 root" },
];

export class TaskScanner {
  private extraPatterns: PatternDef[] = [];

  /** Add custom patterns beyond the built-in set */
  addPattern(category: ThreatCategory, pattern: RegExp, name: string): void {
    this.extraPatterns.push({ category, pattern, name });
  }

  /** Scan a task request for dangerous patterns */
  scan(task: TaskRequest): TaskScanResult {
    const threats: ThreatEntry[] = [];
    const allPatterns = [...PATTERNS, ...this.extraPatterns];

    // Scan description
    this.scanString(task.description, "description", allPatterns, threats);

    // Scan input recursively
    this.scanValue(task.input, "input", allPatterns, threats);

    // Deduplicate by category + pattern name + location
    const seen = new Set<string>();
    const deduped = threats.filter(t => {
      const key = `${t.category}:${t.pattern}:${t.location}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      safe: deduped.length === 0,
      threats: deduped,
    };
  }

  /** Recursively scan a value (string, array, object) */
  private scanValue(
    value: unknown,
    path: string,
    patterns: PatternDef[],
    threats: ThreatEntry[]
  ): void {
    if (typeof value === "string") {
      this.scanString(value, path, patterns, threats);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        this.scanValue(value[i], `${path}[${i}]`, patterns, threats);
      }
    } else if (value && typeof value === "object") {
      for (const [key, val] of Object.entries(value)) {
        this.scanValue(val, `${path}.${key}`, patterns, threats);
      }
    }
  }

  /** Scan a single string against all patterns */
  private scanString(
    text: string,
    location: string,
    patterns: PatternDef[],
    threats: ThreatEntry[]
  ): void {
    for (const def of patterns) {
      const match = def.pattern.exec(text);
      if (match) {
        threats.push({
          category: def.category,
          pattern: def.name,
          matched_text: match[0].slice(0, 100), // truncate long matches
          location,
        });
      }
    }
  }
}
