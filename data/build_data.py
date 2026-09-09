import openpyxl
from collections import Counter, defaultdict
import json
import datetime

import sys
SRC = sys.argv[1] if len(sys.argv) > 1 else "CAR-Data-July_Customer_Base__Voice_Plans___Tablets_.xlsx"

wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
ws = wb["Sheet1"]

def norm(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v.replace("\xa0", " ").strip()
    return v

def catstr(v):
    """Normalize a value meant for a *string* dictionary (handles source
    cells that were typed as numbers, e.g. Rate Plan Code '50' vs 50)."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v.replace("\xa0", " ").strip()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)

def dstr(v):
    if v is None:
        return ""
    if isinstance(v, datetime.datetime):
        return v.strftime("%Y-%m-%d")
    return str(v)

# Dictionaries (string -> index), built incrementally, preserving first-seen order
class Dict_:
    def __init__(self):
        self.map = {}
        self.list = []
    def idx(self, val):
        if val not in self.map:
            self.map[val] = len(self.list)
            self.list.append(val)
        return self.map[val]

D_STORE = Dict_()
D_DISTRICT = Dict_()
D_REGIONAL = Dict_()
D_AREAMGR = Dict_()
D_CUSTOMER = Dict_()
D_RATEPLAN = Dict_()
D_SKU = Dict_()
D_DEVICE = Dict_()
D_ACTDATE = Dict_()
D_BILLCYCLE = Dict_()
D_LASTACT = Dict_()

store_district_count = defaultdict(Counter)
store_regional_count = defaultdict(Counter)
store_areamgr_count = defaultdict(Counter)

F_STORE = []
F_ACTDATE = []
F_BAN = []
F_CTN = []
F_BILLCYCLE = []
F_LASTACT = []
F_FLAGS = []
F_CUSTOMER = []
F_RATEPLAN = []
F_RRC = []
F_SKU = []
F_DEVICE = []
F_BANCHANGED = []
F_SUBRANK = []

n = 0
skipped = 0
for row in ws.iter_rows(min_row=2, values_only=True):
    if row[0] is None:
        continue
    (loc, regional, district, areamgr, store, actdate, ban, ctn, billcycle,
     lastact, status, autopay, customer, rateplan, rrc, sku, device,
     banchanged, protect, ild, upgplus, rateplancsp, featurecsp, subrank) = row

    store_s = catstr(store)
    if not store_s or ban is None or ctn is None:
        skipped += 1
        continue

    st_idx = D_STORE.idx(store_s)
    store_district_count[st_idx][catstr(district)] += 1
    store_regional_count[st_idx][catstr(regional)] += 1
    store_areamgr_count[st_idx][catstr(areamgr)] += 1

    flags = 0
    if norm(autopay).upper().startswith("Y"): flags |= 1
    if norm(protect).upper().startswith("Y"): flags |= 2
    if norm(ild).upper().startswith("Y"): flags |= 4
    if norm(upgplus).upper().startswith("Y"): flags |= 8
    if norm(rateplancsp).upper().startswith("Y"): flags |= 16
    if norm(featurecsp).upper().startswith("Y"): flags |= 32

    F_STORE.append(st_idx)
    F_ACTDATE.append(D_ACTDATE.idx(dstr(actdate)))
    F_BAN.append(int(ban))
    F_CTN.append(int(ctn))
    F_BILLCYCLE.append(D_BILLCYCLE.idx(dstr(billcycle)))
    F_LASTACT.append(D_LASTACT.idx(dstr(lastact)))
    F_FLAGS.append(flags)
    F_CUSTOMER.append(D_CUSTOMER.idx(catstr(customer) or "NA"))
    F_RATEPLAN.append(D_RATEPLAN.idx(catstr(rateplan) or "NA"))
    F_RRC.append(int(rrc) if isinstance(rrc, (int, float)) and rrc is not None else 0)
    F_SKU.append(D_SKU.idx(catstr(sku) or "NA"))
    F_DEVICE.append(D_DEVICE.idx(catstr(device) or "NA"))
    F_BANCHANGED.append(int(banchanged) if isinstance(banchanged, (int, float)) and banchanged is not None else 0)
    F_SUBRANK.append(int(subrank) if isinstance(subrank, (int, float)) and subrank is not None else 0)
    n += 1

print("rows written:", n, "skipped:", skipped)
print("unique stores:", len(D_STORE.list))
print("unique customers:", len(D_CUSTOMER.list))
print("unique rateplans:", len(D_RATEPLAN.list))
print("unique skus:", len(D_SKU.list))
print("unique devices:", len(D_DEVICE.list))
print("unique actdates:", len(D_ACTDATE.list))
print("unique billcycles:", len(D_BILLCYCLE.list))
print("unique lastacts:", len(D_LASTACT.list))

# Resolve store -> district/regional/areamgr via majority vote
STORE_DISTRICT_IDX = []
STORE_REGIONAL_IDX = []
STORE_AREAMGR_IDX = []
for st_idx in range(len(D_STORE.list)):
    best_d = store_district_count[st_idx].most_common(1)[0][0]
    best_r = store_regional_count[st_idx].most_common(1)[0][0]
    best_a = store_areamgr_count[st_idx].most_common(1)[0][0]
    STORE_DISTRICT_IDX.append(D_DISTRICT.idx(best_d))
    STORE_REGIONAL_IDX.append(D_REGIONAL.idx(best_r))
    STORE_AREAMGR_IDX.append(D_AREAMGR.idx(best_a))

print("unique districts:", len(D_DISTRICT.list))
print("unique regionals:", len(D_REGIONAL.list))
print("unique area managers:", len(D_AREAMGR.list))

data = {
    "meta": {
        "rowCount": n,
        "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "CAR-Data-July_Customer_Base__Voice_Plans___Tablets_.xlsx",
    },
    "dict": {
        "stores": D_STORE.list,
        "districts": D_DISTRICT.list,
        "regionals": D_REGIONAL.list,
        "areaManagers": D_AREAMGR.list,
        "customers": D_CUSTOMER.list,
        "ratePlans": D_RATEPLAN.list,
        "skus": D_SKU.list,
        "devices": D_DEVICE.list,
        "actDates": D_ACTDATE.list,
        "billCycles": D_BILLCYCLE.list,
        "lastActs": D_LASTACT.list,
    },
    "storeMeta": {
        "district": STORE_DISTRICT_IDX,
        "regional": STORE_REGIONAL_IDX,
        "areaMgr": STORE_AREAMGR_IDX,
    },
    "cols": {
        "store": F_STORE,
        "actDate": F_ACTDATE,
        "ban": F_BAN,
        "ctn": F_CTN,
        "billCycle": F_BILLCYCLE,
        "lastAct": F_LASTACT,
        "flags": F_FLAGS,
        "customer": F_CUSTOMER,
        "ratePlan": F_RATEPLAN,
        "rrc": F_RRC,
        "sku": F_SKU,
        "device": F_DEVICE,
        "banChangedTo": F_BANCHANGED,
        "subRank": F_SUBRANK,
    }
}

import os, gzip

out_path = "data/car_keys_data.json"
gz_path = out_path + ".gz"
encoded = json.dumps(data, separators=(",", ":")).encode("utf-8")

with open(out_path, "wb") as f:
    f.write(encoded)
with gzip.open(gz_path, "wb", compresslevel=9) as f:
    f.write(encoded)

print("Output size (MB):", round(os.path.getsize(out_path) / (1024*1024), 2))
print("Gzipped size (MB):", round(os.path.getsize(gz_path) / (1024*1024), 2))
print("-> Commit only car_keys_data.json.gz. The plain .json is git-ignored (see .gitignore);")
print("   server.js loads the .gz directly, decompressing once at boot.")
