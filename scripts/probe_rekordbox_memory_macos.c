#include <ctype.h>
#include <inttypes.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  size_t offsets[8];
  size_t offset_count;
  size_t final_offset;
} pointer_chain_t;

typedef struct {
  mach_port_t task;
  mach_vm_address_t base;
} process_ctx_t;

typedef struct {
  uint64_t all_image_info_addr;
  uint64_t all_image_info_size;
  int32_t all_image_info_format;
} task_dyld_info_data_t_local;

static const uint32_t TASK_DYLD_INFO_LOCAL = 17;
static const uint32_t TASK_DYLD_INFO_COUNT_LOCAL =
    sizeof(task_dyld_info_data_t_local) / sizeof(natural_t);

static pointer_chain_t g_master_deck;
static pointer_chain_t g_bpm[4];
static pointer_chain_t g_sample[4];
static pointer_chain_t g_track[4];
static pointer_chain_t g_anlz[4];

static size_t parse_offset(const char *token, int *ok) {
  char *end = NULL;
  unsigned long long value = strtoull(token, &end, 16);
  if (end == token || *end != '\0') *ok = 0;
  return (size_t)value;
}

static int parse_chain(char **tokens, int token_count, pointer_chain_t *chain) {
  if (token_count < 2 || token_count - 1 > 8) return 0;
  int ok = 1;
  for (int i = 0; i < token_count - 1; ++i) {
    chain->offsets[i] = parse_offset(tokens[i], &ok);
  }
  if (!ok) return 0;
  chain->offset_count = (size_t)(token_count - 1);
  chain->final_offset = parse_offset(tokens[token_count - 1], &ok);
  return ok;
}

// Chains file lines: "<kind> <deck> <offsets...> <final>", hex offsets,
// last token is the final field offset. `master` uses deck 0.
static int parse_chain_line(char *line) {
  char *tokens[16];
  int count = 0;
  char *token = strtok(line, " \t\r\n");
  while (token != NULL && count < 16) {
    tokens[count++] = token;
    token = strtok(NULL, " \t\r\n");
  }
  if (count == 0 || tokens[0][0] == '#') return 1;
  if (count < 3) return 0;
  int deck = atoi(tokens[1]);
  pointer_chain_t chain;
  if (!parse_chain(tokens + 2, count - 2, &chain)) return 0;
  if (deck == 0 && strcmp(tokens[0], "master") == 0) {
    g_master_deck = chain;
    return 1;
  }
  if (deck < 1 || deck > 4) return 0;
  if (strcmp(tokens[0], "bpm") == 0) g_bpm[deck - 1] = chain;
  else if (strcmp(tokens[0], "sample") == 0) g_sample[deck - 1] = chain;
  else if (strcmp(tokens[0], "track") == 0) g_track[deck - 1] = chain;
  else if (strcmp(tokens[0], "anlz") == 0) g_anlz[deck - 1] = chain;
  else return 0;
  return 1;
}

static int load_chains(const char *path) {
  FILE *file = fopen(path, "r");
  if (file == NULL) return 0;
  char line[1024];
  int ok = 1;
  while (fgets(line, sizeof(line), file) != NULL) {
    if (!parse_chain_line(line)) {
      ok = 0;
      break;
    }
  }
  fclose(file);
  if (!ok) return 0;
  if (g_master_deck.offset_count == 0) return 0;
  for (int i = 0; i < 4; ++i) {
    if (g_bpm[i].offset_count == 0 || g_sample[i].offset_count == 0 ||
        g_track[i].offset_count == 0 || g_anlz[i].offset_count == 0) {
      return 0;
    }
  }
  return 1;
}

static int read_bytes(mach_port_t task, mach_vm_address_t address, void *out, mach_vm_size_t size) {
  mach_vm_size_t read_size = 0;
  kern_return_t kr =
      mach_vm_read_overwrite(task, address, size, (mach_vm_address_t)out, &read_size);
  return kr == KERN_SUCCESS && read_size == size;
}

static int init_process(process_ctx_t *ctx, pid_t pid) {
  mach_port_t task = MACH_PORT_NULL;
  kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);
  if (kr != KERN_SUCCESS) {
    fprintf(stderr, "task_for_pid failed for pid %d: %s\n", pid, mach_error_string(kr));
    return 0;
  }

  task_dyld_info_data_t_local dyld_info = {0};
  mach_msg_type_number_t count = TASK_DYLD_INFO_COUNT_LOCAL;
  kr = task_info(task, TASK_DYLD_INFO_LOCAL, (task_info_t)&dyld_info, &count);
  if (kr != KERN_SUCCESS) {
    fprintf(stderr, "task_info(TASK_DYLD_INFO) failed: %s\n", mach_error_string(kr));
    return 0;
  }

  unsigned char header[16] = {0};
  if (!read_bytes(task, dyld_info.all_image_info_addr, header, sizeof(header))) {
    fprintf(stderr, "failed to read dyld_all_image_infos\n");
    return 0;
  }
  uint64_t info_array_ptr = 0;
  memcpy(&info_array_ptr, header + 8, sizeof(info_array_ptr));

  uint64_t base = 0;
  if (!read_bytes(task, info_array_ptr, &base, sizeof(base))) {
    fprintf(stderr, "failed to read first dyld image entry\n");
    return 0;
  }

  ctx->task = task;
  ctx->base = base;
  return 1;
}

static int resolve_pointer_chain(const process_ctx_t *ctx, const pointer_chain_t *chain,
                                 mach_vm_address_t *resolved) {
  mach_vm_address_t address = ctx->base;
  for (size_t i = 0; i < chain->offset_count; ++i) {
    mach_vm_address_t next = 0;
    if (!read_bytes(ctx->task, address + chain->offsets[i], &next, sizeof(next))) return 0;
    address = next;
    if (address == 0) return 0;
  }
  *resolved = address + chain->final_offset;
  return 1;
}

static void print_sanitized_string(const char *label, const char *value) {
  char out[160];
  size_t j = 0;
  for (size_t i = 0; value[i] != '\0' && j + 1 < sizeof(out); ++i) {
    unsigned char c = (unsigned char)value[i];
    if (isprint(c)) out[j++] = (char)c;
  }
  out[j] = '\0';
  printf("%s%s\n", label, out);
}

static void print_hex_bytes(const char *label, const unsigned char *buf, size_t size) {
  printf("%s", label);
  for (size_t i = 0; i < size; ++i) printf("%02x", buf[i]);
  printf("\n");
}

static void print_track_fields(const char *raw) {
  const char *title = strstr(raw, "Title:");
  const char *artist = strstr(raw, "Artist:");
  const char *album = strstr(raw, "Album:");
  if (title) {
    title += 6;
    while (*title == ' ') title++;
    char buf[160];
    size_t n = 0;
    while (title[n] && strncmp(title + n, "Artist:", 7) != 0 && n + 1 < sizeof(buf)) {
      buf[n] = title[n];
      n++;
    }
    buf[n] = '\0';
    print_sanitized_string("  title=", buf);
  }
  if (artist) {
    artist += 7;
    while (*artist == ' ') artist++;
    char buf[160];
    size_t n = 0;
    while (artist[n] && strncmp(artist + n, "Album:", 6) != 0 && n + 1 < sizeof(buf)) {
      buf[n] = artist[n];
      n++;
    }
    buf[n] = '\0';
    print_sanitized_string("  artist=", buf);
  }
  if (album) {
    album += 6;
    while (*album == ' ') album++;
    print_sanitized_string("  album=", album);
  }
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: probe_rekordbox_memory_macos <pid> <chains-file>\n");
    return 2;
  }
  pid_t pid = (pid_t)atoi(argv[1]);
  if (pid <= 0) {
    fprintf(stderr, "invalid pid: %s\n", argv[1]);
    return 2;
  }
  if (!load_chains(argv[2])) {
    fprintf(stderr, "failed to load pointer chains from %s\n", argv[2]);
    return 2;
  }

  process_ctx_t ctx = {0};
  if (!init_process(&ctx, pid)) return 1;

  printf("pid=%d\n", pid);
  printf("base=0x%llx\n", (unsigned long long)ctx.base);

  mach_vm_address_t addr = 0;
  uint8_t master = 255;
  if (resolve_pointer_chain(&ctx, &g_master_deck, &addr) &&
      read_bytes(ctx.task, addr, &master, sizeof(master))) {
    printf("master_deck=%u\n", (unsigned)master);
    unsigned char master_bytes[16] = {0};
    if (read_bytes(ctx.task, addr, master_bytes, sizeof(master_bytes))) {
      print_hex_bytes("master_bytes=", master_bytes, sizeof(master_bytes));
    }
  } else {
    printf("master_deck=unreadable\n");
  }

  for (int i = 0; i < 4; ++i) {
    float bpm = 0.0f;
    int64_t samples = 0;
    char track[256];
    char anlz[512];
    memset(track, 0, sizeof(track));
    memset(anlz, 0, sizeof(anlz));

    printf("deck_%d:\n", i + 1);

    if (resolve_pointer_chain(&ctx, &g_bpm[i], &addr) &&
        read_bytes(ctx.task, addr, &bpm, sizeof(bpm))) {
      printf("  bpm=%.3f\n", bpm);
    } else {
      printf("  bpm=unreadable\n");
    }

    if (resolve_pointer_chain(&ctx, &g_sample[i], &addr) &&
        read_bytes(ctx.task, addr, &samples, sizeof(samples))) {
      printf("  sample_position=%" PRId64 "\n", samples);
      printf("  seconds=%.3f\n", (double)samples / 44100.0);
    } else {
      printf("  sample_position=unreadable\n");
    }

    if (resolve_pointer_chain(&ctx, &g_track[i], &addr) &&
        read_bytes(ctx.task, addr, &track, sizeof(track) - 1)) {
      print_sanitized_string("  track_info=", track);
      print_track_fields(track);
    } else {
      printf("  track_info=unreadable\n");
    }

    if (resolve_pointer_chain(&ctx, &g_anlz[i], &addr) &&
        read_bytes(ctx.task, addr, &anlz, sizeof(anlz) - 1)) {
      print_sanitized_string("  anlz_path=", anlz);
    } else {
      printf("  anlz_path=unreadable\n");
    }
  }

  return 0;
}
