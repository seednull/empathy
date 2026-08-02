#pragma once

#include <empathy.h>

#define EMPATHY_UNUSED(x) do { (void)(x); } while(0)

Empathy_Result impl_createInstance(const Empathy_InstanceDesc *desc, Empathy_Instance *instance);
