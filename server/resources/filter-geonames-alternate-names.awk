BEGIN {
  FS = "\t"
  allowedLanguages["zh-CN"] = 1
  allowedLanguages["zh-Hans"] = 1
  allowedLanguages["zh"] = 1
  allowedLanguages["en"] = 1
}

FILENAME ~ /\/cities500\.txt$/ {
  if ($1 != "") {
    referencedIds[$1] = 1
  }
  next
}

FILENAME ~ /\/admin1CodesASCII\.txt$/ || FILENAME ~ /\/admin2Codes\.txt$/ {
  if ($4 != "") {
    referencedIds[$4] = 1
  }
  next
}

FILENAME ~ /\/alternateNamesV2\.txt$/ {
  if (($2 in referencedIds) && ($3 in allowedLanguages) && $4 != "" && $8 != "1") {
    print
  }
}
