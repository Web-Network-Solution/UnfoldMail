CREATE TABLE flows(state TEXT PRIMARY KEY,challenge TEXT NOT NULL UNIQUE,verifier TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE grants(challenge TEXT PRIMARY KEY,payload TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX flows_expiry ON flows(expires);
CREATE INDEX grants_expiry ON grants(expires);
CREATE INDEX limits_expiry ON rate_limits(expires);
