-- Icons of the web manager (e.g. imported from KeePass), one encrypted document per user or organization
CREATE TABLE manager_icons (
  owner_uuid          CHAR(36) NOT NULL PRIMARY KEY,
  data                LONGTEXT NOT NULL,
  revision_date       DATETIME NOT NULL
);
